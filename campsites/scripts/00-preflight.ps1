<#
.SYNOPSIS
    Check campsite demo readiness and optionally refresh one client firewall rule.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Subscription = '0efc44aa-c965-420f-aac4-fff305dbcc97',
    [string]$ResourceGroup = 'campsites-demo-rg',
    [ValidatePattern('^[a-z0-9][a-z0-9-]+$')]
    [string]$ServerName = 'bobward-campsites-pg18',
    [ValidatePattern('^[a-zA-Z_][a-zA-Z0-9_]*$')]
    [string]$Database = 'campsites',
    [string]$EntraUser = 'bobward@microsoft.com',
    [ValidatePattern('^[a-zA-Z0-9_-]{3,128}$')]
    [string]$FirewallRuleName = 'campsites-demo-client',
    [switch]$RefreshFirewall,
    [ValidatePattern('^[a-zA-Z0-9_-]{3,128}$')]
    [string]$RetireFirewallRuleName
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$compose = @('compose', '--project-directory', $root, '--env-file', (Join-Path $root '.local\.env'),
    '-f', (Join-Path $root 'compose.yaml'))
$targetArgs = @('--subscription', $Subscription, '--resource-group', $ResourceGroup, '--server-name', $ServerName)

function Invoke-Azure {
    param([string[]]$Arguments)
    $result = & az @Arguments --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw "Azure CLI failed: $($Arguments[0..2] -join ' ') (exit $LASTEXITCODE)." }
    return $result
}

function Invoke-DatabaseJson {
    param([string]$Query, [string[]]$ConnectionArguments, [string[]]$EnvironmentArguments = @())
    $result = & docker @compose exec -T @EnvironmentArguments db psql -X -At -v ON_ERROR_STOP=1 @ConnectionArguments -c $Query
    if ($LASTEXITCODE -ne 0) {
        throw 'Database preflight query failed. Check the reported connection error; do not disable TLS verification.'
    }
    return ($result -join "`n") | ConvertFrom-Json
}

foreach ($tool in @('az', 'docker')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Required tool not found: $tool." }
}
if (-not (Test-Path (Join-Path $root '.local\.env'))) {
    throw 'Local database is not configured. Run campsites\scripts\local.ps1 -Action Start first.'
}
if ($RetireFirewallRuleName -and (-not $RefreshFirewall -or $RetireFirewallRuleName -eq $FirewallRuleName)) {
    throw '-RetireFirewallRuleName requires -RefreshFirewall and must differ from the managed rule name.'
}

$account = Invoke-Azure @('account', 'show', '--subscription', $Subscription, '-o', 'json') | ConvertFrom-Json
$server = Invoke-Azure @('postgres', 'flexible-server', 'show', '--subscription', $Subscription,
    '--resource-group', $ResourceGroup, '--name', $ServerName, '-o', 'json') | ConvertFrom-Json
Write-Host "Subscription: $($account.name) ($($account.id))"
Write-Host "Target: $ResourceGroup / $ServerName / $Database ($($server.location))"
if ($server.state -ne 'Ready') { throw "Azure server is not Ready: $($server.state)." }
if ($server.authConfig.activeDirectoryAuth -ne 'Enabled' -or $server.authConfig.passwordAuth -ne 'Disabled') {
    throw 'Expected the demo server to use Entra-only authentication; configuration was not changed.'
}
if ($server.network.publicNetworkAccess -ne 'Enabled') {
    throw 'This preflight expects the approved public-endpoint demo configuration; private networking needs a separate plan.'
}

$localQuery = @'
SELECT json_build_object(
    'version', current_setting('server_version_num'),
    'campsites', (SELECT count(*) FROM escape.campsite),
    'reservations', (SELECT count(*) FROM escape.reservation),
    'extensions', (SELECT json_agg(json_build_object('name', extname, 'version', extversion) ORDER BY extname)
        FROM pg_extension WHERE extname IN ('postgis', 'pg_trgm', 'btree_gist'))
);
'@
$local = Invoke-DatabaseJson -Query $localQuery -ConnectionArguments @('-U', 'campsite_admin', '-d', 'campsites')
if ($local.version -ne '180006' -or $local.campsites -ne 30 -or @($local.extensions).Count -ne 3) {
    throw 'Local demo must have PostgreSQL 18.6, exactly 30 campsites, and all three required extensions.'
}

$ip = [string](Invoke-RestMethod -Uri 'https://api.ipify.org' -TimeoutSec 15)
$ip = $ip.Trim()
$address = $null
if (-not [Net.IPAddress]::TryParse($ip, [ref]$address) -or
    $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
    $address.ToString() -ne $ip -or $ip -match '^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' -or
    $address.GetAddressBytes()[0] -ge 224) {
    throw "Public IPv4 detection returned an invalid address: '$ip'. No firewall changes made."
}
$rules = @(Invoke-Azure (@('postgres', 'flexible-server', 'firewall-rule', 'list') + $targetArgs + @('-o', 'json')) |
    ConvertFrom-Json | ForEach-Object { $_ })
$managed = @($rules | Where-Object name -eq $FirewallRuleName)
$retiring = @($rules | Where-Object name -eq $RetireFirewallRuleName)
if ($RetireFirewallRuleName -and $retiring.Count -ne 1) {
    throw "The explicitly named old firewall rule was not found: $RetireFirewallRuleName."
}
if ($retiring.Count -eq 1 -and ($retiring[0].startIpAddress -ne $retiring[0].endIpAddress -or
    $retiring[0].startIpAddress -eq '0.0.0.0')) {
    throw 'Only an explicitly named single-client-IP legacy rule may be retired.'
}
$needsRefresh = $managed.Count -ne 1 -or $managed[0].startIpAddress -ne $ip -or $managed[0].endIpAddress -ne $ip
Write-Host "Current public IPv4: $ip"
Write-Host "Managed firewall rule: $FirewallRuleName"
if ($managed.Count -eq 1) { Write-Host "Previous range: $($managed[0].startIpAddress) - $($managed[0].endIpAddress)" }
if (($needsRefresh -or $RetireFirewallRuleName) -and -not $RefreshFirewall) {
    throw "Firewall refresh required. After approval, rerun with -RefreshFirewall to allow only $ip in '$FirewallRuleName'."
}
if ($needsRefresh -or $RetireFirewallRuleName) {
    $change = "Set '$FirewallRuleName' to $ip only"
    if ($RetireFirewallRuleName) { $change += "; delete legacy rule '$RetireFirewallRuleName' after verifying the replacement" }
    if (-not $PSCmdlet.ShouldProcess("$Subscription / $ResourceGroup / $ServerName", $change)) {
        Write-Host 'Firewall change not applied; SQL readiness has not been checked.'
        return
    }
    if ($needsRefresh) {
        $null = Invoke-Azure (@('postgres', 'flexible-server', 'firewall-rule', 'create') + $targetArgs +
            @('--name', $FirewallRuleName, '--start-ip-address', $ip, '--end-ip-address', $ip, '-o', 'none'))
    }
    $updated = Invoke-Azure (@('postgres', 'flexible-server', 'firewall-rule', 'show') + $targetArgs +
        @('--name', $FirewallRuleName, '-o', 'json')) | ConvertFrom-Json
    if ($updated.startIpAddress -ne $ip -or $updated.endIpAddress -ne $ip) {
        throw 'Firewall readback did not match the approved single IP; no old rule was deleted.'
    }
    if ($RetireFirewallRuleName) {
        $null = Invoke-Azure (@('postgres', 'flexible-server', 'firewall-rule', 'delete') + $targetArgs +
            @('--name', $RetireFirewallRuleName, '--yes', '-o', 'none'))
    }
    Write-Host 'Firewall refreshed. Azure propagation can take several minutes; rerun preflight if the connection is not yet accepted.'
}
$unmanaged = @($rules | Where-Object { $_.name -ne $FirewallRuleName -and $_.name -ne $RetireFirewallRuleName })
if ($unmanaged.Count) {
    Write-Warning "Other firewall rules were preserved: $($unmanaged.name -join ', '). Review their scope separately."
}

$targetQuery = @'
SELECT json_build_object(
    'version', current_setting('server_version_num'),
    'tls', (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()),
    'application_tables', (SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')),
    'extensions', (SELECT json_agg(json_build_object('name', name, 'version', version, 'installed', installed) ORDER BY name, version)
        FROM pg_available_extension_versions WHERE name IN ('postgis', 'pg_trgm', 'btree_gist')),
    'allowlist', current_setting('azure.extensions')
);
'@
$oldPassword = [Environment]::GetEnvironmentVariable('PGPASSWORD', 'Process')
try {
    $token = Invoke-Azure @('account', 'get-access-token', '--subscription', $Subscription,
        '--resource-type', 'oss-rdbms', '--query', 'accessToken', '-o', 'tsv')
    if ([string]::IsNullOrWhiteSpace(($token -join ''))) { throw 'Azure CLI returned an empty database access token.' }
    $env:PGPASSWORD = ($token -join '').Trim()
    $target = Invoke-DatabaseJson -Query $targetQuery -ConnectionArguments @('-h', $server.fullyQualifiedDomainName,
        '-p', '5432', '-U', $EntraUser, '-d', $Database) -EnvironmentArguments @(
        '-e', 'PGPASSWORD', '-e', 'PGSSLMODE=verify-full', '-e', 'PGSSLROOTCERT=system',
        '-e', 'PGCONNECT_TIMEOUT=20', '-e', 'PGOPTIONS=-c default_transaction_read_only=on')
} finally {
    [Environment]::SetEnvironmentVariable('PGPASSWORD', $oldPassword, 'Process')
    $token = $null
}

$problems = @()
if ($target.version -ne $local.version) { $problems += "Engine mismatch: local=$($local.version), Azure=$($target.version)." }
if ($target.tls -ne $true) { $problems += 'Azure SQL session did not report TLS.' }
$allowlist = @($target.allowlist -split ',' | ForEach-Object { $_.Trim().ToLowerInvariant() })
foreach ($extension in $local.extensions) {
    $available = @($target.extensions | Where-Object name -eq $extension.name)
    $matching = @($available | Where-Object version -eq $extension.version)
    $installed = @($available | Where-Object installed)
    if ($allowlist -notcontains $extension.name) { $problems += "Extension not allowlisted: $($extension.name)." }
    if ($matching.Count -eq 0 -or ($installed.Count -gt 0 -and $installed[0].version -ne $extension.version)) {
        $problems += "Extension mismatch: $($extension.name), local=$($extension.version), Azure available=$($available.version -join ',')."
    }
}
Write-Host "Engine versions: local=$($local.version), Azure=$($target.version)"
Write-Host "Azure application tables: $($target.application_tables) (no data changed)"
if ($problems.Count) { throw "Demo preflight blocked:`n$($problems -join "`n")" }

[pscustomobject]@{
    Status = 'Ready'
    Subscription = $account.id
    Server = $server.fullyQualifiedDomainName
    Database = $Database
    PublicIPv4 = $ip
    FirewallRule = $FirewallRuleName
    ServerVersionNum = $target.version
    Extensions = $local.extensions
    TargetEmpty = $target.application_tables -eq 0
    MigrationPerformed = $false
}
