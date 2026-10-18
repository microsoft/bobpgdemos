$preflight = Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts\00-preflight.ps1'

function az { throw 'Unmocked Azure CLI command attempted in unit tests.' }
function docker { throw 'Unmocked Docker command attempted in unit tests.' }

Describe 'Campsite demo preflight' {
    BeforeEach {
        $global:CampsitePreflightTestState = @{
            OriginalPassword = [Environment]::GetEnvironmentVariable('PGPASSWORD', 'Process')
            Ip = '203.0.113.20'
            Rules = @(@{ name = 'campsites-demo-client'; startIpAddress = '203.0.113.20'; endIpAddress = '203.0.113.20' })
            Writes = [Collections.Generic.List[string]]::new()
            DockerCalls = [Collections.Generic.List[string]]::new()
            CloudQueries = 0
            FailToken = $false
            FailSql = $false
            WrongReadback = $false
            TargetVersion = '180006'
            PostgisVersion = '3.6.4'
            Tls = $true
            Allowlist = 'postgis, pg_trgm, btree_gist'
            TargetTables = 0
        }
        $env:PGPASSWORD = 'pre-existing-test-value'
        Mock Test-Path { $true } -ParameterFilter { $Path -like '*\.local\.env' }
        Mock Invoke-RestMethod { $global:CampsitePreflightTestState.Ip }
        Mock az {
            $global:LASTEXITCODE = 0
            $state = $global:CampsitePreflightTestState
            $command = $args -join ' '
            switch -Regex ($command) {
                '^account show ' { '{"name":"Demo subscription","id":"demo-subscription"}'; break }
                '^postgres flexible-server show ' {
                    '{"state":"Ready","location":"centralus","fullyQualifiedDomainName":"demo.postgres.database.azure.com","authConfig":{"activeDirectoryAuth":"Enabled","passwordAuth":"Disabled"},"network":{"publicNetworkAccess":"Enabled"}}'
                    break
                }
                'firewall-rule list ' { ConvertTo-Json -InputObject @($state.Rules) -Depth 4 -Compress; break }
                'firewall-rule create ' { $state.Writes.Add($command); break }
                'firewall-rule show ' {
                    $ip = if ($state.WrongReadback) { '203.0.113.99' } else { $state.Ip }
                    @{ name = 'campsites-demo-client'; startIpAddress = $ip; endIpAddress = $ip } | ConvertTo-Json -Compress
                    break
                }
                'firewall-rule delete ' { $state.Writes.Add($command); break }
                '^account get-access-token ' {
                    if ($state.FailToken) { $global:LASTEXITCODE = 1 } else { 'mock-token-not-a-real-secret' }
                    break
                }
                default { throw "Unexpected Azure test command: $command" }
            }
        }
        Mock docker {
            $global:LASTEXITCODE = 0
            $state = $global:CampsitePreflightTestState
            $command = $args -join ' '
            $state.DockerCalls.Add($command)
            if ($command -match 'PGSSLMODE=verify-full') {
                $state.CloudQueries++
                if ($state.FailSql) { $global:LASTEXITCODE = 1; return }
                @{
                    version = $state.TargetVersion
                    tls = $state.Tls
                    application_tables = $state.TargetTables
                    allowlist = $state.Allowlist
                    extensions = @(
                        @{ name = 'postgis'; version = $state.PostgisVersion; installed = $false }
                        @{ name = 'pg_trgm'; version = '1.6'; installed = $false }
                        @{ name = 'btree_gist'; version = '1.8'; installed = $false }
                    )
                } | ConvertTo-Json -Depth 5 -Compress
            } else {
                '{"version":"180006","campsites":30,"reservations":3,"extensions":[{"name":"postgis","version":"3.6.4"},{"name":"pg_trgm","version":"1.6"},{"name":"btree_gist","version":"1.8"}]}'
            }
        }
    }
    AfterEach {
        [Environment]::SetEnvironmentVariable('PGPASSWORD', $global:CampsitePreflightTestState.OriginalPassword, 'Process')
        Remove-Variable CampsitePreflightTestState -Scope Global
    }

    It 'passes read-only checks with exact engine and extension matches' {
        $result = & $preflight
        $result.Status | Should Be 'Ready'
        $result.TargetEmpty | Should Be $true
        $result.MigrationPerformed | Should Be $false
        $global:CampsitePreflightTestState.Writes.Count | Should Be 0
        $global:CampsitePreflightTestState.CloudQueries | Should Be 1
        $env:PGPASSWORD | Should Be 'pre-existing-test-value'
        $cloud = $global:CampsitePreflightTestState.DockerCalls | Where-Object { $_ -match 'PGSSLMODE=verify-full' }
        $cloud | Should Match 'PGSSLROOTCERT=system'
        $cloud | Should Match 'default_transaction_read_only=on'
        $cloud | Should Not Match 'mock-token-not-a-real-secret'
    }
    It 'blocks stale IPs without modifying Azure by default' {
        $global:CampsitePreflightTestState.Ip = '203.0.113.21'
        { & $preflight } | Should Throw 'Firewall refresh required'
        $global:CampsitePreflightTestState.Writes.Count | Should Be 0
        $global:CampsitePreflightTestState.CloudQueries | Should Be 0
    }
    It 'previews refresh without applying it or claiming readiness' {
        $global:CampsitePreflightTestState.Ip = '203.0.113.21'
        $result = & $preflight -RefreshFirewall -WhatIf
        $result | Should BeNullOrEmpty
        $global:CampsitePreflightTestState.Writes.Count | Should Be 0
        $global:CampsitePreflightTestState.CloudQueries | Should Be 0
    }
    It 'refreshes only the stable rule with the same start and end IPv4' {
        $global:CampsitePreflightTestState.Ip = '203.0.113.21'
        $result = & $preflight -RefreshFirewall
        $result.Status | Should Be 'Ready'
        $global:CampsitePreflightTestState.Writes.Count | Should Be 1
        $global:CampsitePreflightTestState.Writes[0] | Should Match '--name campsites-demo-client'
        $global:CampsitePreflightTestState.Writes[0] | Should Match '--start-ip-address 203.0.113.21 --end-ip-address 203.0.113.21'
    }
    It 'does not write when the managed rule is already current' {
        $null = & $preflight -RefreshFirewall
        $global:CampsitePreflightTestState.Writes.Count | Should Be 0
    }
    It 'creates a missing managed rule only with explicit refresh' {
        $global:CampsitePreflightTestState.Rules = @()
        { & $preflight } | Should Throw 'Firewall refresh required'
        $null = & $preflight -RefreshFirewall
        $global:CampsitePreflightTestState.Writes.Count | Should Be 1
    }
    It 'retires only an explicitly named single-IP rule after replacement readback' {
        $global:CampsitePreflightTestState.Rules = @(@{ name = 'legacy-client'; startIpAddress = '203.0.113.10'; endIpAddress = '203.0.113.10' })
        $null = & $preflight -RefreshFirewall -RetireFirewallRuleName legacy-client
        $global:CampsitePreflightTestState.Writes.Count | Should Be 2
        $global:CampsitePreflightTestState.Writes[0] | Should Match 'firewall-rule create'
        $global:CampsitePreflightTestState.Writes[1] | Should Match 'firewall-rule delete.*--name legacy-client'
    }
    It 'never retires the legacy rule if replacement verification fails' {
        $global:CampsitePreflightTestState.Rules = @(@{ name = 'legacy-client'; startIpAddress = '203.0.113.10'; endIpAddress = '203.0.113.10' })
        $global:CampsitePreflightTestState.WrongReadback = $true
        { & $preflight -RefreshFirewall -RetireFirewallRuleName legacy-client } | Should Throw 'readback'
        $global:CampsitePreflightTestState.Writes.Count | Should Be 1
    }
    It 'rejects retiring an AllowAzureServices rule' {
        $global:CampsitePreflightTestState.Rules = @(@{ name = 'legacy-client'; startIpAddress = '0.0.0.0'; endIpAddress = '0.0.0.0' })
        { & $preflight -RefreshFirewall -RetireFirewallRuleName legacy-client } | Should Throw 'single-client-IP'
        $global:CampsitePreflightTestState.Writes.Count | Should Be 0
    }
    It 'rejects private or malformed IP detection before firewall writes' {
        foreach ($ip in @('0.0.0.0', '127.0.0.1', '192.168.1.2', '::1', 'invalid')) {
            $global:CampsitePreflightTestState.Ip = $ip
            { & $preflight -RefreshFirewall } | Should Throw 'invalid address'
        }
        $global:CampsitePreflightTestState.Writes.Count | Should Be 0
    }
    It 'blocks engine and extension mismatches' {
        $global:CampsitePreflightTestState.TargetVersion = '180007'
        { & $preflight } | Should Throw 'Engine mismatch'
        $global:CampsitePreflightTestState.TargetVersion = '180006'
        $global:CampsitePreflightTestState.PostgisVersion = '3.6.1'
        { & $preflight } | Should Throw 'Extension mismatch'
    }
    It 'blocks missing allowlist entries and unencrypted sessions' {
        $global:CampsitePreflightTestState.Allowlist = 'pg_trgm,btree_gist'
        { & $preflight } | Should Throw 'not allowlisted'
        $global:CampsitePreflightTestState.Allowlist = 'postgis,pg_trgm,btree_gist'
        $global:CampsitePreflightTestState.Tls = $false
        { & $preflight } | Should Throw 'did not report TLS'
    }
    It 'restores the previous password on SQL and token failures' {
        $global:CampsitePreflightTestState.FailSql = $true
        { & $preflight } | Should Throw 'Database preflight query failed'
        $env:PGPASSWORD | Should Be 'pre-existing-test-value'
        $global:CampsitePreflightTestState.FailSql = $false
        $global:CampsitePreflightTestState.FailToken = $true
        { & $preflight } | Should Throw 'Azure CLI failed'
        $env:PGPASSWORD | Should Be 'pre-existing-test-value'
    }
    It 'reports a nonempty target without changing its data' {
        $global:CampsitePreflightTestState.TargetTables = 2
        $result = & $preflight
        $result.TargetEmpty | Should Be $false
        $result.MigrationPerformed | Should Be $false
        $global:CampsitePreflightTestState.Writes.Count | Should Be 0
    }
}
