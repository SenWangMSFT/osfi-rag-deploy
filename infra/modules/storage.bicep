@description('Storage account name (3-24 lowercase letters and digits).')
@minLength(3)
@maxLength(24)
param name string

@description('Region for the storage account.')
param location string

@description('Tags applied to every resource.')
param tags object

@description('Blob containers to create.')
param containerNames string[]

resource storage 'Microsoft.Storage/storageAccounts@2026-04-01' = {
  name: name
  location: location
  // The tag exempts the account from a policy in Microsoft's test tenant that forces publicNetworkAccess=Disabled,
  // which would cut the Function App off from its host storage. Other tenants ignore it.
  tags: union(tags, { SecurityControl: 'Ignore' })
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    publicNetworkAccess: 'Enabled'
    allowBlobPublicAccess: false
    // Every caller (Function App, people via az login) uses Entra ID, so account keys stay off.
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2026-04-01' = {
  parent: storage
  name: 'default'
  properties: {
    // Lets an accidentally deleted Function App package be recovered. Documents never land in this account.
    deleteRetentionPolicy: {
      enabled: true
      days: 7
    }
  }
}

resource containers 'Microsoft.Storage/storageAccounts/blobServices/containers@2026-04-01' = [
  for containerName in containerNames: {
    parent: blobService
    name: containerName
    properties: {
      publicAccess: 'None'
    }
  }
]

output name string = storage.name
output id string = storage.id
output blobEndpoint string = storage.properties.primaryEndpoints.blob
