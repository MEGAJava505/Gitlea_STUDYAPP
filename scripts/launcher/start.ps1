$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Set-Location -LiteralPath $root
$log = $null
$temp = $null
function Say([string]$Message) {
    Write-Host $Message
    if ($script:log) { Add-Content -LiteralPath $script:log -Value $Message }
}
function Invoke-Docker([string[]]$Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & docker @Arguments 2>&1 | Tee-Object -FilePath $script:log -Append | Out-Host
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previous }
    if ($code -ne 0) { throw 'Docker command failed. Review the launcher log.' }
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
try {
    [IO.Directory]::CreateDirectory((Join-Path $root 'logs/launcher')) | Out-Null
    $log = Join-Path $root ('logs/launcher/' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $PID + '.log')
    Say 'SECURITY GATE OPEN: Next.js 15.1.3 requires security remediation. Local demo only; do not deploy or expose this stack publicly.'
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Install Docker Desktop with Docker Compose v2, then start Docker Desktop.'
    }
    Invoke-Docker -Arguments @('compose', 'version')
    Invoke-Docker -Arguments @('info', '--format', '{{.ServerVersion}}')
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
    $known = @('NODE_ENV', 'APP_BASE_URL', 'SESSION_SECRET', 'GITEA_ADMIN_PASSWORD', 'GITEA_ADMIN_TOKEN', 'SMTP_HOST')
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
    foreach ($key in $known) {
        if (Test-Path -LiteralPath ('Env:' + $key)) { throw "Unset inherited $key before launching: it can override .env. The launcher will not change your environment." }
    }
    Say 'AUTH STATUS: UI availability does not prove authentication. Gitea API token, OIDC and SMTP must be configured and verified separately; unset or placeholder settings mean UI-only operation. QR activation is not implemented by this launcher.'
    if (Unsafe ([string]$values['GITEA_ADMIN_TOKEN']) 16) { Say 'WARNING: GITEA_ADMIN_TOKEN is missing or a placeholder; Gitea-backed authentication/provisioning is not ready.' }
    if (-not $values['SMTP_HOST'] -or $values['SMTP_HOST'] -eq 'smtp.local') { Say 'WARNING: SMTP is unconfigured; email activation is not ready.' }
    Invoke-Docker -Arguments @('compose', '--env-file', '.env', 'config', '--quiet')
    Invoke-Docker -Arguments @('compose', '--env-file', '.env', 'up', '-d', '--build', 'app', 'gitea', 'proxy')
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
