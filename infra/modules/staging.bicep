// Storage for the SharePoint sync: the staging container files pass through until they're indexed, and the sync
// state (delta links, per-file status) with the site registry. Separate from the main account so nothing here is
// kept after deletion: no blob soft delete, no versions.
@description('Storage account name (3-24 lowercase letters and digits).')
@minLength(3)
@maxLength(24)
param name string

@description('Region for the storage account.')
param location string

@description('Tags applied to every resource.')
param tags object

@description('Container the sync copies new and edited files into until the indexer has read them.')
param stagingContainerName string

@description('Container for the sync state and the site registry.')
param stateContainerName string

resource storage 'Microsoft.Storage/storageAccounts@2026-04-01' = {
  name: name
  location: location
  // The tag exempts the account from a policy in Microsoft's test tenant that forces publicNetworkAccess=Disabled;
  // other tenants ignore it. The indexer and the Function App reach the account's public endpoint with Entra ID.
  tags: union(tags, { SecurityControl: 'Ignore' })
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    publicNetworkAccess: 'Enabled'
    allowBlobPublicAccess: false
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
    // A deleted staged file must really be gone.
    deleteRetentionPolicy: {
      enabled: false
    }
    containerDeleteRetentionPolicy: {
      enabled: false
    }
    isVersioningEnabled: false
    changeFeed: {
      enabled: false
    }
  }
}

resource containers 'Microsoft.Storage/storageAccounts/blobServices/containers@2026-04-01' = [
  for containerName in [stagingContainerName, stateContainerName]: {
    parent: blobService
    name: containerName
    properties: {
      publicAccess: 'None'
    }
  }
]

// The sync deletes each staged file once it's indexed; this catches anything a failed run leaves behind.
resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2026-04-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'delete-stale-staged-files'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                '${stagingContainerName}/'
              ]
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: 1
                }
              }
            }
          }
        }
      ]
    }
  }
  dependsOn: [
    containers
  ]
}

output name string = storage.name
output id string = storage.id
output blobEndpoint string = storage.properties.primaryEndpoints.blob
