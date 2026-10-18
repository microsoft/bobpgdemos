[CmdletBinding()]
param(
    [ValidateSet('Start', 'Verify', 'Demo', 'Stop', 'RoundTrip')]
    [string]$Action = 'Start'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$local = Join-Path $root '.local'
$envFile = Join-Path $local '.env'
$compose = @('compose', '--project-directory', $root, '--env-file', $envFile, '-f', (Join-Path $root 'compose.yaml'))

function Invoke-Docker {
    param([string[]]$Arguments)
    & docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Docker command failed (exit $LASTEXITCODE): $($Arguments[0])" }
}

function Invoke-SqlFile {
    param([string]$Name, [string]$Database = 'campsites')
    Get-Content -Raw (Join-Path $root "sql\$Name") |
        & docker @compose exec -T db psql -X -v ON_ERROR_STOP=1 -U campsite_admin -d $Database
    if ($LASTEXITCODE -ne 0) { throw "SQL check failed: $Name ($Database)" }
}

function Assert-LocalVersion {
    $version = & docker @compose exec -T db psql -X -At -U campsite_admin -d campsites -c 'SHOW server_version_num'
    if ($LASTEXITCODE -ne 0) { throw 'Could not read local PostgreSQL version.' }
    if (($version -join '').Trim() -ne '180006') {
        throw "Expected PostgreSQL 18.6 (180006), found $version. Revalidate the Azure target before changing the pin."
    }
}

if ($Action -eq 'Start') {
    Invoke-Docker -Arguments @('info', '--format', '{{.ServerVersion}}')
    if (-not (Test-Path $envFile)) {
        New-Item -ItemType Directory -Path $local -Force | Out-Null
        $bytes = [byte[]]::new(32)
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        $password = [Convert]::ToBase64String($bytes)
        [IO.File]::WriteAllText($envFile, "CAMPSITE_DB_PASSWORD=$password`n")
    }
    Invoke-Docker -Arguments ($compose + @('up', '-d', '--wait', '--wait-timeout', '120'))
    Assert-LocalVersion
    Invoke-SqlFile '04-verify.sql'
    Write-Host 'Ready: localhost:55432 / campsites / campsite_admin'
    Write-Host 'Local-only password is in campsites\.local\.env (git-ignored). Do not share it.'
    return
}
if (-not (Test-Path $envFile)) { throw 'Run local.ps1 -Action Start first.' }
if ($Action -ne 'Stop') { Assert-LocalVersion }
switch ($Action) {
    'Verify' { Invoke-SqlFile '04-verify.sql' }
    'Demo' { Invoke-SqlFile '03-demo.sql' }
    'Stop' { Invoke-Docker -Arguments ($compose + @('stop')) }
    'RoundTrip' {
        $id = [Guid]::NewGuid().ToString('N')
        $database = "campsites_verify_$id"
        $archive = "/tmp/campsites-$id.dump"
        $created = $false
        try {
            Invoke-Docker -Arguments ($compose + @('exec', '-T', 'db', 'pg_dump', '-U', 'campsite_admin', '-d', 'campsites', '-Fc', '-f', $archive))
            Invoke-Docker -Arguments ($compose + @('exec', '-T', 'db', 'createdb', '-U', 'campsite_admin', $database))
            $created = $true
            Invoke-Docker -Arguments ($compose + @('exec', '-T', 'db', 'pg_restore', '-U', 'campsite_admin', '-d', $database, '--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', $archive))
            Invoke-SqlFile '04-verify.sql' $database
            Write-Host 'PASS: custom-format dump restored and verified in a separate database.'
        } finally {
            if ($created) {
                Invoke-Docker -Arguments ($compose + @('exec', '-T', 'db', 'dropdb', '-U', 'campsite_admin', $database))
            }
            Invoke-Docker -Arguments ($compose + @('exec', '-T', 'db', 'rm', '-f', $archive))
        }
    }
}
