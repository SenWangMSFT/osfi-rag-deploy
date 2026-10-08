@description('Search service name.')
param name string

@description('Region for the search service. Must support agentic retrieval and semantic ranker.')
param location string

@description('Tags applied to every resource.')
param tags object

@description('Pricing tier. standard = S1.')
@allowed([
  'basic'
  'standard'
])
param sku string

resource search 'Microsoft.Search/searchServices@2025-05-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: sku
  }
  // The indexer, skills, vectorizer and knowledge base reach Foundry and Storage with this identity.
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    replicaCount: 1
    partitionCount: 1
    hostingMode: 'Default'
    semanticSearch: 'standard'
    // Keys stay available for the portal; scripts and the Function App use Entra ID.
    authOptions: {
      aadOrApiKey: {
        aadAuthFailureMode: 'http401WithBearerChallenge'
      }
    }
  }
}

output name string = search.name
output id string = search.id
output endpoint string = 'https://${search.name}.search.windows.net'
output principalId string = search.identity.principalId
