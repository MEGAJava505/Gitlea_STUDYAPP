$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'start.ps1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) {
    throw ('start.ps1 parse errors: ' + (($parseErrors | ForEach-Object { $_.Message }) -join '; '))
}

$required = @('Get-HostPort', 'Test-PortFree', 'Assert-UniqueHostPorts')
$functions = $ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $required -contains $node.Name
}, $true)
foreach ($name in $required) {
    $definition = $functions | Where-Object { $_.Name -eq $name } | Select-Object -First 1
    if (-not $definition) { throw "Missing launcher function: $name" }
    Invoke-Expression $definition.Extent.Text
}

function Assert-Equal([object]$Actual, [object]$Expected, [string]$Message) {
    if ($Actual -ne $Expected) { throw ($Message + ': expected ' + $Expected + ', got ' + $Actual) }
}

Assert-Equal (Get-HostPort -Values @{} -Key 'PROXY_HTTP_PORT' -Default 8080) 8080 'Missing port uses its default'
Assert-Equal (Get-HostPort -Values @{ PROXY_HTTP_PORT = '18080' } -Key 'PROXY_HTTP_PORT' -Default 8080) 18080 'Explicit valid port is preserved'

foreach ($value in @('', 'abc', '+8080', '0', '65536')) {
    try {
        Get-HostPort -Values @{ PROXY_HTTP_PORT = $value } -Key 'PROXY_HTTP_PORT' -Default 8080 | Out-Null
        throw "Invalid port '$value' was accepted"
    } catch {
        if ($_.Exception.Message -like "Invalid port '$value' was accepted") { throw }
        if ($_.Exception.Message -notlike '*PROXY_HTTP_PORT*between 1 and 65535*') { throw }
    }
}

Assert-UniqueHostPorts -Ports @(
    @{ Name = 'GITEA_HTTP_PORT'; Port = 3000 },
    @{ Name = 'PROXY_HTTP_PORT'; Port = 8080 }
)
try {
    Assert-UniqueHostPorts -Ports @(
        @{ Name = 'GITEA_HTTP_PORT'; Port = 8080 },
        @{ Name = 'PROXY_HTTP_PORT'; Port = 8080 }
    )
    throw 'Duplicate host port assignment was accepted'
} catch {
    if ($_.Exception.Message -eq 'Duplicate host port assignment was accepted') { throw }
    if ($_.Exception.Message -notlike '*GITEA_HTTP_PORT, PROXY_HTTP_PORT=8080*') { throw }
}

try {
    Test-PortFree -Port 0 | Out-Null
    throw 'Out-of-range host port was accepted by the availability check'
} catch {
    if ($_.Exception.Message -eq 'Out-of-range host port was accepted by the availability check') { throw }
    if ($_.Exception.Message -notlike '*between 1 and 65535*') { throw }
}

Write-Output 'Windows launcher port checks passed.'
