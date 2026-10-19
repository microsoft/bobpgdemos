param location string
param tags object
param planName string
param appName string
param stagingSlotName string
param productionPgUser string
param stagingPgUser string
param pgHost string
param pgDatabase string
param pgPort string

resource plan 'Microsoft.Web/serverfarms@2025-03-01' = {
  name: planName
  location: location
  kind: 'linux'
  tags: tags
  sku: {
    name: 'P1v3'
    tier: 'PremiumV3'
    size: 'P1v3'
    family: 'Pv3'
    capacity: 1
  }
  properties: {
    reserved: true
  }
}

var commonAppSettings = [
  {
    name: 'PORT'
    value: '8080'
  }
  {
    name: 'PGHOST'
    value: pgHost
  }
  {
    name: 'PGPORT'
    value: pgPort
  }
  {
    name: 'PGDATABASE'
    value: pgDatabase
  }
  {
    name: 'DB_AUTH'
    value: 'entra'
  }
  {
    name: 'AZURE_AUTH_MODE'
    value: 'managed-identity'
  }
  {
    name: 'NODE_ENV'
    value: 'production'
  }
  {
    name: 'NPM_CONFIG_PRODUCTION'
    value: 'false'
  }
  {
    name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
    value: 'true'
  }
  {
    name: 'ENABLE_ORYX_BUILD'
    value: 'true'
  }
  {
    name: 'ORYX_DISABLE_COMPRESSION'
    value: 'true'
  }
  {
    name: 'WEBSITES_CONTAINER_START_TIME_LIMIT'
    value: '1800'
  }
]

resource production 'Microsoft.Web/sites@2026-08-01' = {
  name: appName
  location: location
  kind: 'app,linux'
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      alwaysOn: true
      http20Enabled: true
      healthCheckPath: '/healthz'
      linuxFxVersion: 'NODE|24-lts'
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
    }
  }
}

resource productionSettings 'Microsoft.Web/sites/config@2026-08-01' = {
  parent: production
  name: 'appsettings'
  properties: union(toObject(commonAppSettings, setting => setting.name, setting => setting.value), {
    PGUSER: productionPgUser
    PUBLIC_ORIGIN: 'https://${production.properties.defaultHostName}'
  })
}

resource productionScmAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2026-08-01' = {
  parent: production
  name: 'scm'
  properties: {
    allow: false
  }
}

resource productionFtpAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2026-08-01' = {
  parent: production
  name: 'ftp'
  properties: {
    allow: false
  }
}

resource productionSlotSettings 'Microsoft.Web/sites/config@2026-08-01' = {
  parent: production
  name: 'slotConfigNames'
  properties: {
    appSettingNames: [
      'PGUSER'
      'PUBLIC_ORIGIN'
    ]
  }
}

resource staging 'Microsoft.Web/sites/slots@2026-08-01' = {
  parent: production
  name: stagingSlotName
  location: location
  kind: 'app,linux'
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      alwaysOn: true
      http20Enabled: true
      healthCheckPath: '/healthz'
      linuxFxVersion: 'NODE|24-lts'
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
    }
  }
}

resource stagingSettings 'Microsoft.Web/sites/slots/config@2026-08-01' = {
  parent: staging
  name: 'appsettings'
  properties: union(toObject(commonAppSettings, setting => setting.name, setting => setting.value), {
    PGUSER: stagingPgUser
    PUBLIC_ORIGIN: 'https://${staging.properties.defaultHostName}'
  })
}

resource stagingScmAuth 'Microsoft.Web/sites/slots/basicPublishingCredentialsPolicies@2026-08-01' = {
  parent: staging
  name: 'scm'
  properties: {
    allow: false
  }
}

resource stagingFtpAuth 'Microsoft.Web/sites/slots/basicPublishingCredentialsPolicies@2026-08-01' = {
  parent: staging
  name: 'ftp'
  properties: {
    allow: false
  }
}

output planId string = plan.id
output productionHost string = production.properties.defaultHostName
output productionId string = production.id
output productionPrincipalId string = production.identity.principalId
output stagingHost string = staging.properties.defaultHostName
output stagingId string = staging.id
output stagingPrincipalId string = staging.identity.principalId
