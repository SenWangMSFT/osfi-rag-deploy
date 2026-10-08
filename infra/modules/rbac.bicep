@description('Foundry (AIServices) account name.')
param foundryName string

@description('Search service name.')
param searchName string

@description('Storage account name.')
param storageAccountName string

@description('Staging storage account name (SharePoint sync).')
param stagingAccountName string

@description('Principal ID of the search service system-assigned identity.')
param searchPrincipalId string

@description('Principal ID of the Function App user-assigned identity.')
param functionPrincipalId string

@description('Principal ID of the Foundry project system-assigned identity; the agent calls the knowledge base MCP endpoint as it.')
param projectPrincipalId string

@description('Object ID of the deploying user. Empty skips user assignments.')
param userPrincipalId string = ''

@description('Principal ID of an optional CI/CD pipeline identity. Empty skips its assignments.')
param ciPrincipalId string = ''

var roles = {
  cognitiveServicesUser: 'a97b65f3-24c7-4388-baec-2e87135dc908'
  cognitiveServicesOpenAIUser: '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
  foundryUser: '53ca6127-db72-4b80-b1b0-d745d6d5456d'
  searchIndexDataReader: '1407120a-92aa-4202-b7e9-c0e197c71c8f'
  searchIndexDataContributor: '8ebe5a00-799e-43f5-93ac-243d3dce84a7'
  searchServiceContributor: '7ca78c08-252a-4471-8644-bb5ff32d4ba0'
  storageBlobDataReader: '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
  storageBlobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
}

type roleAssignment = {
  principalId: string
  principalType: 'ServicePrincipal' | 'User'
  roleId: string
}

var hasUser = !empty(userPrincipalId)
var hasCi = !empty(ciPrincipalId)

// Search calls Content Understanding, the embedding model and the knowledge-base LLM as itself.
// The Function App invokes the Foundry agent (Responses API). The pipeline runs scripts/setup_search.py, which sets the
// Content Understanding defaults, and scripts/setup_agent.py, which creates the agent versions.
// Scheduled Foundry evaluations call their judge model as the project's identity.
var foundryAssignments roleAssignment[] = concat(
  [
    { principalId: searchPrincipalId, principalType: 'ServicePrincipal', roleId: roles.cognitiveServicesUser }
    { principalId: searchPrincipalId, principalType: 'ServicePrincipal', roleId: roles.cognitiveServicesOpenAIUser }
    { principalId: functionPrincipalId, principalType: 'ServicePrincipal', roleId: roles.foundryUser }
    { principalId: projectPrincipalId, principalType: 'ServicePrincipal', roleId: roles.cognitiveServicesOpenAIUser }
  ],
  hasUser
    ? [
        { principalId: userPrincipalId, principalType: 'User', roleId: roles.cognitiveServicesUser }
        { principalId: userPrincipalId, principalType: 'User', roleId: roles.cognitiveServicesOpenAIUser }
        { principalId: userPrincipalId, principalType: 'User', roleId: roles.foundryUser }
      ]
    : [],
  hasCi
    ? [
        { principalId: ciPrincipalId, principalType: 'ServicePrincipal', roleId: roles.cognitiveServicesUser }
        { principalId: ciPrincipalId, principalType: 'ServicePrincipal', roleId: roles.foundryUser }
      ]
    : []
)

// The Function App queries the knowledge base, follows citationUrls, runs the indexer, reads the staging index and
// copies its chunks into the chunk index with permissions, and deletes chunks of removed documents by key.
// The Foundry project identity reads the index through the agent knowledge base's MCP endpoint.
// The pipeline creates and updates the search objects in search/*.json.
var searchAssignments roleAssignment[] = concat(
  [
    { principalId: functionPrincipalId, principalType: 'ServicePrincipal', roleId: roles.searchIndexDataReader }
    { principalId: functionPrincipalId, principalType: 'ServicePrincipal', roleId: roles.searchIndexDataContributor }
    { principalId: functionPrincipalId, principalType: 'ServicePrincipal', roleId: roles.searchServiceContributor }
    { principalId: projectPrincipalId, principalType: 'ServicePrincipal', roleId: roles.searchIndexDataReader }
  ],
  hasUser
    ? [
        { principalId: userPrincipalId, principalType: 'User', roleId: roles.searchIndexDataReader }
        { principalId: userPrincipalId, principalType: 'User', roleId: roles.searchIndexDataContributor }
        { principalId: userPrincipalId, principalType: 'User', roleId: roles.searchServiceContributor }
      ]
    : [],
  hasCi ? [{ principalId: ciPrincipalId, principalType: 'ServicePrincipal', roleId: roles.searchServiceContributor }] : []
)

var storageAssignments roleAssignment[] = concat(
  [
    { principalId: searchPrincipalId, principalType: 'ServicePrincipal', roleId: roles.storageBlobDataReader }
  ],
  hasUser
    ? [
        { principalId: userPrincipalId, principalType: 'User', roleId: roles.storageBlobDataContributor }
      ]
    : []
)

// The indexer reads staged files; the Function App stages and deletes them and keeps the sync state. The operator
// uploads the site registry (scripts/onboard_sites.py) and reads the state (scripts/sync.py).
var stagingAssignments roleAssignment[] = concat(
  [
    { principalId: searchPrincipalId, principalType: 'ServicePrincipal', roleId: roles.storageBlobDataReader }
    { principalId: functionPrincipalId, principalType: 'ServicePrincipal', roleId: roles.storageBlobDataContributor }
  ],
  hasUser
    ? [
        { principalId: userPrincipalId, principalType: 'User', roleId: roles.storageBlobDataContributor }
      ]
    : []
)

resource foundry 'Microsoft.CognitiveServices/accounts@2026-07-01' existing = {
  name: foundryName
}

resource search 'Microsoft.Search/searchServices@2025-05-01' existing = {
  name: searchName
}

resource storage 'Microsoft.Storage/storageAccounts@2026-04-01' existing = {
  name: storageAccountName
}

resource staging 'Microsoft.Storage/storageAccounts@2026-04-01' existing = {
  name: stagingAccountName
}

resource foundryRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for a in foundryAssignments: {
    scope: foundry
    name: guid(foundry.id, a.principalId, a.roleId)
    properties: {
      principalId: a.principalId
      principalType: a.principalType
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', a.roleId)
    }
  }
]

resource searchRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for a in searchAssignments: {
    scope: search
    name: guid(search.id, a.principalId, a.roleId)
    properties: {
      principalId: a.principalId
      principalType: a.principalType
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', a.roleId)
    }
  }
]

resource storageRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for a in storageAssignments: {
    scope: storage
    name: guid(storage.id, a.principalId, a.roleId)
    properties: {
      principalId: a.principalId
      principalType: a.principalType
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', a.roleId)
    }
  }
]

resource stagingRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for a in stagingAssignments: {
    scope: staging
    name: guid(staging.id, a.principalId, a.roleId)
    properties: {
      principalId: a.principalId
      principalType: a.principalType
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', a.roleId)
    }
  }
]
