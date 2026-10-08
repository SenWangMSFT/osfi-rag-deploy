@description('Function App name.')
param name string

@description('Flex Consumption plan name.')
param planName string

@description('User-assigned managed identity for the Function App.')
param identityName string

@description('Region. Must support Flex Consumption.')
param location string

@description('Tags applied to every resource.')
param tags object

@description('Storage account for host state and the deployment package.')
param storageAccountName string

@description('Blob container that holds the Flex Consumption deployment package.')
param deploymentContainerName string

@description('Application Insights connection string.')
param appInsightsConnectionString string

@description('Python runtime version.')
param pythonVersion string

@description('App settings for the POC code (endpoints and object names).')
param appSettings { *: string }

var storageBlobDataOwner = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'

resource storage 'Microsoft.Storage/storageAccounts@2026-04-01' existing = {
  name: storageAccountName
}

// User-assigned so its role on storage exists before the app is created and first pulls its package.
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: identityName
  location: location
  tags: tags
}

// Covers host storage (including the timer's schedule monitor) and the deployment container.
resource storageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, identity.id, storageBlobDataOwner)
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataOwner)
  }
}

resource plan 'Microsoft.Web/serverfarms@2025-03-01' = {
  name: planName
  location: location
  tags: tags
  kind: 'functionapp'
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  properties: {
    reserved: true
  }
}

resource functionApp 'Microsoft.Web/sites@2025-03-01' = {
  name: name
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      minTlsVersion: '1.2'
    }
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}${deploymentContainerName}'
          authentication: {
            type: 'UserAssignedIdentity'
            userAssignedIdentityResourceId: identity.id
          }
        }
      }
      scaleAndConcurrency: {
        maximumInstanceCount: 40
        instanceMemoryMB: 2048
      }
      runtime: {
        name: 'python'
        version: pythonVersion
      }
    }
  }
  dependsOn: [
    storageRole
  ]
}

resource settings 'Microsoft.Web/sites/config@2025-03-01' = {
  parent: functionApp
  name: 'appsettings'
  properties: union(appSettings, {
    AzureWebJobsStorage__accountName: storage.name
    AzureWebJobsStorage__credential: 'managedidentity'
    AzureWebJobsStorage__clientId: identity.properties.clientId
    APPLICATIONINSIGHTS_CONNECTION_STRING: appInsightsConnectionString
    // Tells the app code which managed identity to use for Search and Storage.
    AZURE_CLIENT_ID: identity.properties.clientId
  })
}

output name string = functionApp.name
output url string = 'https://${functionApp.properties.defaultHostName}'
output principalId string = identity.properties.principalId
