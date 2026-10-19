targetScope = 'subscription'

@minLength(1)
@maxLength(64)
param environmentName string

@minLength(1)
param location string

param sessionId string
param deployedBy string
param createdAt string

var tags = {
  'app-onboard-skill': 'true'
  'app-onboard-session-id': sessionId
  'created-at': createdAt
  environment: environmentName
  'deployed-by': deployedBy
}

resource existingResourceGroup 'Microsoft.Resources/resourceGroups@2025-04-01' existing = {
  name: 'campsites-demo-rg'
}

module appService './modules/app-service.bicep' = {
  name: 'campsites-app-service'
  scope: existingResourceGroup
  params: {
    location: location
    tags: tags
    planName: 'plan-campsites-dev-a59e'
    appName: 'app-campsites-dev-a59e'
    stagingSlotName: 'staging'
    productionPgUser: 'campsites_web'
    stagingPgUser: 'campsites_web_staging'
    pgHost: 'bobward-campsites-pg18.postgres.database.azure.com'
    pgDatabase: 'campsites'
    pgPort: '5432'
  }
}

output planId string = appService.outputs.planId
output productionHost string = appService.outputs.productionHost
output productionId string = appService.outputs.productionId
output productionPrincipalId string = appService.outputs.productionPrincipalId
output stagingHost string = appService.outputs.stagingHost
output stagingId string = appService.outputs.stagingId
output stagingPrincipalId string = appService.outputs.stagingPrincipalId
