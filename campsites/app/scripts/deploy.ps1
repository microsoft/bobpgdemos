[CmdletBinding()]
param(
    [string]$Subscription = '0efc44aa-c965-420f-aac4-fff305dbcc97',
    [string]$ResourceGroup = 'campsites-demo-rg',
    [string]$AppName = 'app-campsites-dev-a59e',
    [switch]$Provision,
    [switch]$StagingOnly
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$local = Join-Path (Split-Path $root -Parent) '.local'
$deploymentName = 'campsites-app-a59e'

function Invoke-Azure {
    param([string[]]$Arguments)
    $result = & az @Arguments --subscription $Subscription --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw "Azure command failed: $($Arguments[0..1] -join ' ')." }
    return $result
}

if ($Provision) {
    $result = Invoke-Azure @('deployment', 'sub', 'create', '--location', 'centralus',
        '--name', $deploymentName, '--template-file', "$root\infra\main.bicep",
        '--parameters', "$root\infra\main.parameters.json", '--query', 'properties.outputs', '-o', 'json')
} else {
    $result = Invoke-Azure @('deployment', 'sub', 'show', '--name', $deploymentName,
        '--query', 'properties.outputs', '-o', 'json')
}
$outputs = ($result -join "`n") | ConvertFrom-Json
if (-not $outputs.productionPrincipalId.value -or -not $outputs.stagingPrincipalId.value) {
    throw 'Deployment outputs are missing managed identity IDs.'
}
$oldVariables = @{}
foreach ($name in @('PGHOST', 'PGDATABASE', 'PGPORT', 'PGUSER', 'DB_AUTH', 'AZURE_AUTH_MODE')) {
    $oldVariables[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
    $env:PGHOST = 'bobward-campsites-pg18.postgres.database.azure.com'
    $env:PGDATABASE = 'campsites'
    $env:PGPORT = '5432'
    $env:PGUSER = 'bobward@microsoft.com'
    $env:DB_AUTH = 'entra'
    $env:AZURE_AUTH_MODE = 'cli'
    & node "$PSScriptRoot\grant-database-access.mjs" $outputs.productionPrincipalId.value $outputs.stagingPrincipalId.value
    if ($LASTEXITCODE -ne 0) { throw 'Managed identity database grants failed.' }
} finally {
    foreach ($name in $oldVariables.Keys) {
        [Environment]::SetEnvironmentVariable($name, $oldVariables[$name], 'Process')
    }
}

$zipPath = Join-Path $local "campsites-app-$([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')).zip"
Add-Type -AssemblyName System.IO.Compression
$zip = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
try {
    $files = @(
        Get-Item "$root\package.json", "$root\package-lock.json", "$root\tsconfig.json"
        Get-ChildItem "$root\src", "$root\public" -File -Recurse
    )
    foreach ($file in $files) {
        $entry = [IO.Path]::GetRelativePath($root, $file.FullName).Replace('\', '/')
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $entry) | Out-Null
    }
} finally { $zip.Dispose() }

$slots = if ($StagingOnly) { @('staging') } else { @('staging', 'production') }
$expectedScriptHash = (Get-FileHash "$root\public\app.js" -Algorithm SHA256).Hash
foreach ($slot in $slots) {
    $slotArgs = @()
    $hostName = $outputs.productionHost.value
    $resourceId = $outputs.productionId.value
    if ($slot -eq 'staging') {
        $slotArgs = @('--slot', 'staging')
        $hostName = $outputs.stagingHost.value
        $resourceId = $outputs.stagingId.value
    }
    $settings = Invoke-Azure (@('webapp', 'config', 'appsettings', 'list', '-g', $ResourceGroup,
        '-n', $AppName) + $slotArgs + @('-o', 'json')) | ConvertFrom-Json
    if (@($settings | Where-Object { $_.name -eq 'SCM_DO_BUILD_DURING_DEPLOYMENT' -and $_.value -eq 'true' }).Count -ne 1) {
        throw "Oryx build is not enabled for $slot."
    }
    $bearer = Invoke-Azure @('account', 'get-access-token', '--resource', 'https://management.azure.com/',
        '--query', 'accessToken', '-o', 'tsv')
    try {
        $headers = @{ Authorization = "Bearer $(($bearer -join '').Trim())" }
        $scmHost = $hostName.Replace('.azurewebsites.net', '.scm.azurewebsites.net')
        Write-Host "Deploying $slot with Entra-authenticated Kudu zipdeploy."
        $response = Invoke-WebRequest -Uri "https://$scmHost/api/zipdeploy?isAsync=true" -Method Post `
            -InFile $zipPath -ContentType 'application/zip' -Headers $headers -TimeoutSec 120
        $statusUrl = [string]$response.Headers.Location
        if (-not $statusUrl) { throw "Kudu did not return a deployment status URL for $slot." }
        if ($statusUrl.StartsWith('/')) { $statusUrl = "https://$scmHost$statusUrl" }
        $completed = $false
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            Start-Sleep -Seconds 10
            $status = Invoke-RestMethod -Uri $statusUrl -Headers $headers -TimeoutSec 30
            if ($status.status -eq 3) { throw "Kudu deployment failed for $slot. Inspect $($status.log_url)." }
            if ($status.status -eq 4) { $completed = $true; break }
        }
        if (-not $completed) { throw "Kudu deployment did not finish within ten minutes for $slot." }
        Write-Host "Build/deployment completed for $slot."
    } finally { $headers = $null; $bearer = $null }

    $ready = $false
    for ($attempt = 0; $attempt -lt 18; $attempt++) {
        $health = Invoke-WebRequest -Uri "https://$hostName/readyz" -SkipHttpErrorCheck -TimeoutSec 30
        if ($health.StatusCode -eq 200 -and ($health.Content | ConvertFrom-Json).status -eq 'ready') {
            $scriptResponse = Invoke-WebRequest -Uri "https://$hostName/app.js" -SkipHttpErrorCheck -TimeoutSec 30
            $scriptHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
                [Text.Encoding]::UTF8.GetBytes([string]$scriptResponse.Content)))
            $searchResponse = Invoke-WebRequest -Uri "https://$hostName/api/campsites?available_only=false" -SkipHttpErrorCheck -TimeoutSec 30
            if ($scriptResponse.StatusCode -eq 200 -and $scriptHash -eq $expectedScriptHash -and
                $searchResponse.StatusCode -eq 200 -and
                ($searchResponse.Content | ConvertFrom-Json).execution.sql -match 'ST_X') {
                $ready = $true
                break
            }
        }
        Write-Host "$slot readiness HTTP $($health.StatusCode); waiting for the expected app release."
        Start-Sleep -Seconds 10
    }
    if (-not $ready) { throw "$slot did not become database-ready." }
    $search = Invoke-RestMethod -Uri "https://$hostName/api/campsites?available_only=false" -TimeoutSec 30
    if (@($search.campsites).Count -ne 6) { throw "$slot did not return six combined search results." }
    if ($null -eq $search.campsites[0].longitude -or $null -eq $search.campsites[0].latitude) {
        throw "$slot did not return PostGIS map coordinates."
    }
    if ($search.execution.operation -ne 'search' -or @($search.execution.parameters).Count -ne 9) {
        throw "$slot did not return the SQL execution details."
    }
    foreach ($asset in @('leaflet.js', 'leaflet.css')) {
        $null = Invoke-WebRequest -Uri "https://$hostName/vendor/$asset" -TimeoutSec 30
    }
    $names = Invoke-RestMethod -Uri "https://$hostName/api/name-search?name=Lake%20Samamish%20Heron" -TimeoutSec 30
    if ($names.matches[0].name -ne 'Lake Sammamish Heron') { throw "$slot typo search failed." }
    $policy = Invoke-Azure @('rest', '--method', 'get', '--url',
        "$resourceId/basicPublishingCredentialsPolicies/scm?api-version=2025-03-01",
        '--query', 'properties.allow', '-o', 'tsv')
    if (($policy -join '').Trim() -ne 'false') { throw "SCM basic authentication is not disabled for $slot." }
    Write-Host "PASS: $slot expected release, readiness, six matches, PostGIS coordinates, SQL inspector, map assets, typo match, and disabled SCM basic authentication."
}
if (-not $StagingOnly) { Write-Host "Live app: https://$($outputs.productionHost.value)" }
Write-Host "Staging: https://$($outputs.stagingHost.value)"
