$ErrorActionPreference = 'Stop'
# Force UTF-8 console/log output so Cyrillic and box-drawing are not mojibake.
try {
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [Console]::OutputEncoding = $utf8
    [Console]::InputEncoding = $utf8
    $OutputEncoding = $utf8
    if (Get-Command chcp -ErrorAction SilentlyContinue) { chcp 65001 | Out-Null }
} catch { }

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Set-Location -LiteralPath $root
$log = $null
$temp = $null
$dockerWaitSeconds = 120
$pullRetries = 3

function Say([string]$Message) {
    Write-Host $Message
    if ($script:log) {
        [IO.File]::AppendAllText($script:log, $Message + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    }
}

function Write-DockerStream([object]$Item) {
    if ($null -eq $Item) { return }
    if ($Item -is [System.Management.Automation.ErrorRecord]) {
        $text = [string]$Item.Exception.Message
        if (-not $text) { $text = [string]$Item }
    } else {
        $text = [string]$Item
    }
    if (-not $text) { return }
    Write-Host $text
    if ($script:log) {
        [IO.File]::AppendAllText($script:log, $text + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    }
}

function Invoke-Docker([string[]]$Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $code = 0
    try {
        # Capture streams without piping native stderr into Tee-Object (avoids NativeCommandError).
        $output = & docker @Arguments 2>&1
        $code = $LASTEXITCODE
        foreach ($item in @($output)) { Write-DockerStream $item }
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) {
        throw ('Docker command failed (exit ' + $code + '). Review the launcher log.')
    }
}

function Invoke-DockerSoft([string[]]$Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & docker @Arguments 2>&1
        $code = $LASTEXITCODE
        $text = (@($output) | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) {
                $msg = [string]$_.Exception.Message
                if ($msg) { $msg } else { [string]$_ }
            } else { [string]$_ }
        }) -join [Environment]::NewLine
        return @{ Code = $code; Text = $text }
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Test-DockerEngine {
    $result = Invoke-DockerSoft -Arguments @('info', '--format', '{{.ServerVersion}}')
    return ($result.Code -eq 0 -and $result.Text.Trim().Length -gt 0)
}

function Wait-DockerEngine([int]$TimeoutSeconds) {
    if (Test-DockerEngine) { return $true }
    Say ('Docker engine is not ready. Waiting up to ' + $TimeoutSeconds + ' seconds for Docker Desktop / engine...')
    $desktop = @(
        (Join-Path ${env:ProgramFiles} 'Docker\Docker\Docker Desktop.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Docker\Docker\Docker Desktop.exe')
    ) | Where-Object { $_ -and [IO.File]::Exists($_) } | Select-Object -First 1
    if ($desktop) {
        try {
            Start-Process -FilePath $desktop | Out-Null
            Say 'Started Docker Desktop. Waiting for the engine pipe...'
        } catch {
            Say ('Could not auto-start Docker Desktop: ' + $_.Exception.Message)
        }
    } else {
        Say 'Docker Desktop executable was not found. Start Docker Desktop manually, then re-run the launcher.'
    }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while ($watch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        Start-Sleep -Seconds 3
        if (Test-DockerEngine) {
            Say ('Docker engine is ready after ' + [int]$watch.Elapsed.TotalSeconds + ' seconds.')
            return $true
        }
    }
    return $false
}

function Test-PortFree([int]$Port) {
    if ($Port -le 0 -or $Port -gt 65535) { return $true }
    try {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Any, $Port)
        $listener.Start()
        $listener.Stop()
        return $true
    } catch {
        return $false
    }
}

function Get-EnvInt([hashtable]$Values, [string]$Key, [int]$Default) {
    $raw = [string]$Values[$Key]
    if (-not $raw) { return $Default }
    $parsed = 0
    if ([int]::TryParse($raw, [ref]$parsed)) { return $parsed }
    return $Default
}

function New-Secret {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Unsafe([string]$Value, [int]$Minimum) {
    return ($Value.Length -lt $Minimum -or $Value -match '(?i)replace|placeholder|changeme|change-me|example|your[-_]|devknown|^local-github-dev-admin-password$' -or $Value -match '^(.)\1+$' -or $Value.Contains('$'))
}

function Test-PullRetriable([string]$Text) {
    return ($Text -match '(?i)unexpected EOF|short read|TLS handshake timeout|connection reset|i/o timeout|network is unreachable|temporary failure')
}

try {
    [IO.Directory]::CreateDirectory((Join-Path $root 'logs/launcher')) | Out-Null
    $log = Join-Path $root ('logs/launcher/' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $PID + '.log')
    Say 'SECURITY GATE OPEN: Next.js 15.1.3 requires security remediation. Local demo only; do not deploy or expose this stack publicly.'
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Install Docker Desktop with Docker Compose v2, then start Docker Desktop.'
    }
    Invoke-Docker -Arguments @('compose', 'version')
    if (-not (Wait-DockerEngine -TimeoutSeconds $dockerWaitSeconds)) {
        throw 'Docker engine did not become ready. Open Docker Desktop, wait until it says Running, then re-run Start-Gitlea.cmd. No containers were started.'
    }
    $info = Invoke-DockerSoft -Arguments @('info', '--format', '{{.ServerVersion}}')
    Say ('Docker engine version: ' + $info.Text.Trim())

    $envPath = Join-Path $root '.env'
    if (-not [IO.File]::Exists($envPath)) {
        $example = Join-Path $root '.env.example'
        if (-not [IO.File]::Exists($example)) { throw 'Missing .env.example. Restore it from the repository.' }
        $lines = @([IO.File]::ReadAllLines($example) | Where-Object { $_ -notmatch '^\s*(?:export\s+)?(?:NODE_ENV|SESSION_SECRET|GITEA_ADMIN_PASSWORD)\s*=' })
        $lines += @('NODE_ENV=production', ('SESSION_SECRET=' + (New-Secret)), ('GITEA_ADMIN_PASSWORD=' + (New-Secret)))
        $temp = Join-Path $root ('.env.launcher-' + [Guid]::NewGuid().ToString('N') + '.tmp')
        [IO.File]::WriteAllLines($temp, [string[]]$lines, (New-Object Text.UTF8Encoding($false)))
        try {
            [IO.File]::Move($temp, $envPath)
            Say 'Created .env from .env.example with random session and administrator secrets. Keep this file private.'
        } catch {
            if (-not [IO.File]::Exists($envPath)) { throw }
            Say '.env appeared concurrently; preserving and validating it.'
        } finally {
            if ($temp -and [IO.File]::Exists($temp)) { [IO.File]::Delete($temp) }
            $temp = $null
        }
    }

    $known = @('NODE_ENV', 'APP_BASE_URL', 'SESSION_SECRET', 'GITEA_ADMIN_PASSWORD', 'GITEA_ADMIN_TOKEN', 'SMTP_HOST', 'GITEA_HTTP_PORT', 'GITEA_SSH_PORT', 'PROXY_HTTP_PORT', 'PROXY_HTTPS_PORT', 'OIDC_ISSUER', 'OIDC_CLIENT_ID')
    $values = @{}
    foreach ($line in [IO.File]::ReadAllLines($envPath)) {
        if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') {
            $key = $Matches[1]
            $value = $Matches[2].Trim()
            if ($known -notcontains $key) { continue }
            if ($values.ContainsKey($key)) { throw "Duplicate $key in .env. Keep one explicit value; no file was overwritten." }
            if ($value.StartsWith('"') -or $value.StartsWith("'")) {
                $quote = $value.Substring(0, 1)
                $end = $value.IndexOf($quote, 1)
                if ($end -lt 1 -or $value.Substring($end + 1).Trim() -notmatch '^(#.*)?$') {
                    throw "Use a single-line literal for $key in .env. No interpolation or escapes are supported by the launcher."
                }
                $value = $value.Substring(1, $end - 1)
            } else { $value = ($value -replace '\s+#.*$', '').Trim() }
            if ($value.Contains('$') -or $value.Contains('`') -or $value.Contains('\')) {
                throw "Use an explicit literal for $key in .env; interpolation and escapes are unsupported."
            }
            $values[$key] = $value
        }
    }
    if ([string]$values['NODE_ENV'] -ne 'production') { throw 'Set NODE_ENV=production in existing .env before launch; development identity issuance must remain disabled. Nothing was overwritten.' }
    if (Unsafe ([string]$values['SESSION_SECRET']) 32) {
        throw 'Existing .env needs a non-placeholder SESSION_SECRET of at least 32 characters from at least 32 random bytes. Update it manually; rotating it invalidates sessions. Nothing was overwritten.'
    }
    if (Unsafe ([string]$values['GITEA_ADMIN_PASSWORD']) 16) {
        throw 'Existing .env needs an explicit strong GITEA_ADMIN_PASSWORD (at least 16 characters). Update it manually and reconcile any existing Gitea administrator password. Volumes and credentials were not reset.'
    }
    $base = ([string]$values['APP_BASE_URL']).TrimEnd('/')
    $uri = $null
    if (-not [Uri]::TryCreate($base, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin @('http', 'https') -or -not $uri.Host -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $base -match '\s') {
        throw 'Set APP_BASE_URL in .env to an explicit http(s) public application URL without credentials, query, fragment, or whitespace. Keep its port consistent with the existing proxy configuration.'
    }
    foreach ($key in @('NODE_ENV', 'APP_BASE_URL', 'SESSION_SECRET', 'GITEA_ADMIN_PASSWORD', 'GITEA_ADMIN_TOKEN', 'SMTP_HOST')) {
        if (Test-Path -LiteralPath ('Env:' + $key)) { throw "Unset inherited $key before launching: it can override .env. The launcher will not change your environment." }
    }

    Say 'AUTH STATUS: UI availability does not prove authentication. Configure and verify Gitea API token, OIDC and SMTP separately; unset or placeholder settings mean UI-only operation.'
    if (Unsafe ([string]$values['GITEA_ADMIN_TOKEN']) 16) {
        Say 'WARNING: GITEA_ADMIN_TOKEN is missing or a placeholder. Next step: create a Gitea admin API token and set GITEA_ADMIN_TOKEN in .env (never commit it).'
    }
    if (-not $values['SMTP_HOST'] -or $values['SMTP_HOST'] -eq 'smtp.local') {
        Say 'WARNING: SMTP is unconfigured (SMTP_HOST=smtp.local). Next step: set real SMTP_* values in .env for email activation, or use group QR activation instead.'
    }
    if (-not $values['OIDC_ISSUER'] -or -not $values['OIDC_CLIENT_ID']) {
        Say 'WARNING: OIDC is unconfigured. Next step: fill OIDC_* in .env per docs/SHOWCASE_AUTH.md, or continue with activation-only demo.'
    }

    $giteaHttp = Get-EnvInt $values 'GITEA_HTTP_PORT' 3000
    $giteaSsh = Get-EnvInt $values 'GITEA_SSH_PORT' 2222
    $proxyHttp = Get-EnvInt $values 'PROXY_HTTP_PORT' 8080
    $proxyHttps = Get-EnvInt $values 'PROXY_HTTPS_PORT' 8443
    $busy = @()
    foreach ($pair in @(
        @{ Name = 'GITEA_HTTP_PORT'; Port = $giteaHttp },
        @{ Name = 'GITEA_SSH_PORT'; Port = $giteaSsh },
        @{ Name = 'PROXY_HTTP_PORT'; Port = $proxyHttp },
        @{ Name = 'PROXY_HTTPS_PORT'; Port = $proxyHttps }
    )) {
        if (-not (Test-PortFree -Port ([int]$pair.Port))) {
            $busy += ($pair.Name + '=' + $pair.Port)
        }
    }
    if ($busy.Count -gt 0) {
        throw ('Host port already allocated: ' + ($busy -join ', ') + '. Free the port(s) or set different GITEA_HTTP_PORT / GITEA_SSH_PORT / PROXY_HTTP_PORT / PROXY_HTTPS_PORT in .env, then re-run. Nothing was started.')
    }
    Say ('Port preflight OK: Gitea HTTP ' + $giteaHttp + ', SSH ' + $giteaSsh + ', proxy HTTP ' + $proxyHttp + ', HTTPS ' + $proxyHttps)

    Invoke-Docker -Arguments @('compose', '--env-file', '.env', 'config', '--quiet')

    $attempt = 0
    $upOk = $false
    $lastUp = ''
    while ($attempt -lt $pullRetries -and -not $upOk) {
        $attempt++
        Say ('Starting stack (compose up attempt ' + $attempt + '/' + $pullRetries + ')...')
        $up = Invoke-DockerSoft -Arguments @('compose', '--env-file', '.env', 'up', '-d', '--build', 'app', 'gitea', 'proxy')
        $lastUp = $up.Text
        foreach ($line in ($up.Text -split "`r?`n")) { if ($line) { Say $line } }
        if ($up.Code -eq 0) { $upOk = $true; break }
        if (($attempt -lt $pullRetries) -and (Test-PullRetriable $up.Text)) {
            Say ('Transient image-pull / network error detected. Retrying compose up in 5 seconds (attempt ' + ($attempt + 1) + '/' + $pullRetries + ')...')
            Start-Sleep -Seconds 5
            continue
        }
        throw ('Docker command failed (exit ' + $up.Code + '). Review the launcher log.')
    }
    if (-not $upOk) {
        throw ('Docker compose up failed after ' + $pullRetries + ' attempts. Last output retained in the launcher log.')
    }

    Say 'Waiting up to 300 seconds for the application /api/health endpoint (HTTP 200).'
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $ready = $false
    while ($watch.Elapsed.TotalSeconds -lt 300) {
        $remaining = [int][Math]::Floor(300 - $watch.Elapsed.TotalSeconds)
        if ($remaining -lt 1) { break }
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri ($base + '/api/health') -TimeoutSec ([Math]::Min(5, $remaining)) -MaximumRedirection 0 -ErrorAction Stop
            if ([int]$response.StatusCode -eq 200 -and $watch.Elapsed.TotalSeconds -le 300) { $ready = $true; break }
        } catch { }
        $delay = [int][Math]::Min(2000, [Math]::Max(0, (300 - $watch.Elapsed.TotalSeconds) * 1000))
        if ($delay -gt 0) { Start-Sleep -Milliseconds $delay }
    }
    if (-not $ready) { throw 'Application readiness timed out. Inspect docker compose --env-file .env logs --tail 100 app gitea proxy. Check APP_BASE_URL, proxy ports and service health. Data is preserved.' }
    Say ('Application returned HTTP 200: ' + $base)
    Say 'This confirms UI readiness only. The security and full-auth gates remain OPEN.'
    if ($env:GITLEA_NO_BROWSER -ne '1') {
        try { Start-Process -FilePath $base | Out-Null } catch { Say ('Browser could not be opened. Visit ' + $base) }
    }
    Say ('Launcher log: ' + $log)
    exit 0
} catch {
    Say ('ERROR: ' + $_.Exception.Message)
    if ($log) { Say ('Launcher log: ' + $log) }
    exit 1
} finally {
    if ($temp -and [IO.File]::Exists($temp)) { [IO.File]::Delete($temp) }
}
