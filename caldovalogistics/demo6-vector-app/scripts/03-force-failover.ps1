<#
.SYNOPSIS
    Force a real failover of the Caldova HorizonDB cluster (step 5 of the walkthrough).

.DESCRIPTION
    Uses the documented REST call (there is no az horizondb failover command yet):
    the current ReadWrite replica is set to Read, so the primary goes down at once
    and a standby replica in another availability zone is promoted. Connections
    drop for a few seconds; the endpoints then point at the new primary.

    Requires at least two replicas (high availability). To add a standby:
      az rest --method PUT --uri ".../clusters/<cluster>/pools/DefaultPool/replicas/<name>?api-version=2026-01-20-preview" `
        --body '{"location":"westus3","properties":{"role":"Read"}}'

    Asks for confirmation; pass -Confirm:$false to skip it.

.EXAMPLE
    .\demo6-vector-app\scripts\03-force-failover.ps1
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string]$ResourceGroup = 'caldova-logistics-rg',
    [string]$ClusterName = 'caldova-logistics',
    [int]$TimeoutSeconds = 600
)

$ErrorActionPreference = 'Stop'
$apiVersion = '2026-01-20-preview'

$subscriptionId = az account show --query id --output tsv
if ($LASTEXITCODE -ne 0 -or -not $subscriptionId) { throw 'Sign in with az login first.' }
$replicasUri = "https://management.azure.com/subscriptions/$subscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.HorizonDB/clusters/$ClusterName/pools/DefaultPool/replicas"

function Get-Replicas {
    $json = az rest --method GET --uri "$replicasUri`?api-version=$apiVersion"
    if ($LASTEXITCODE -ne 0) { throw "Failed to list the replicas of '$ClusterName'." }
    ($json | ConvertFrom-Json).value
}

function Show-Replicas($replicas) {
    $replicas | ForEach-Object { "  {0,-34} {1,-9} zone {2}" -f $_.name, $_.properties.role, $_.properties.availabilityZone } | Write-Host
}

$replicas = @(Get-Replicas)
$primary = $replicas | Where-Object { $_.properties.role -eq 'ReadWrite' } | Select-Object -First 1
$standbys = @($replicas | Where-Object { $_.properties.role -eq 'Read' })
Write-Host "Replicas of ${ClusterName}:"
Show-Replicas $replicas
if (-not $primary) { throw 'No ReadWrite replica found.' }
if (-not $standbys) { throw 'Forced failover needs a standby replica. Enable high availability (see Get-Help) first.' }

if (-not $PSCmdlet.ShouldProcess("$ClusterName primary '$($primary.name)' (zone $($primary.properties.availabilityZone))", 'Force a failover')) {
    return
}

$body = New-TemporaryFile
try {
    Set-Content -Path $body -Value '{"properties":{"role":"Read"}}' -Encoding ascii
    $started = Get-Date
    az rest --method PATCH --uri "$replicasUri/$($primary.name)?api-version=$apiVersion" --body "@$body" --output none
    if ($LASTEXITCODE -ne 0) { throw 'The failover request failed.' }
} finally {
    Remove-Item $body -ErrorAction SilentlyContinue
}
Write-Host "Failover requested at $($started.ToString('T')). Waiting for a new primary..."

do {
    Start-Sleep -Seconds 5
    $replicas = @(Get-Replicas)
    $newPrimary = $replicas | Where-Object { $_.properties.role -eq 'ReadWrite' -and $_.name -ne $primary.name } | Select-Object -First 1
    $elapsed = [int]((Get-Date) - $started).TotalSeconds
} until ($newPrimary -or $elapsed -ge $TimeoutSeconds)

if (-not $newPrimary) { throw "No new primary after $TimeoutSeconds s. Check the cluster in the Azure portal." }
Write-Host "New primary '$($newPrimary.name)' in zone $($newPrimary.properties.availabilityZone) after about $elapsed s:"
Show-Replicas $replicas
