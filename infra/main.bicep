// Citation-grounded RAG POC: SharePoint sites -> sync job (Function App) -> short-lived staging container -> AI Search
// indexer with Content Understanding -> chunk index with per-institution permissions -> Foundry IQ knowledge base ->
// Function App grounding gate. A Foundry Agent Service prompt agent can answer instead, calling a second (extractive)
// knowledge base over MCP. Both answer modes search with the signed-in user's token.
// POC posture: public endpoints, Entra ID everywhere.
targetScope = 'subscription'

import { modelDeployment } from 'types.bicep'

@description('Short name used to derive resource names, e.g. osfi-rag-poc.')
@minLength(3)
@maxLength(20)
param environmentName string

@description('Region for every resource. canadacentral supports Content Understanding, agentic retrieval and Flex Consumption.')
param location string = 'canadacentral'

@description('Resource group that holds all POC resources.')
param resourceGroupName string = 'rg-${environmentName}'

@description('Object ID of the person running the deployment; gets data-plane roles so the setup scripts work with az login. Empty skips.')
param principalId string = ''

@description('Principal ID of an optional CI/CD pipeline identity; gets the data-plane roles a deployment pipeline needs. Empty skips.')
param ciPrincipalId string = ''

@description('Azure AI Search tier. Basic caps indexer source files at 16 MB, which some annual reports exceed, so the default is S1.')
@allowed([
  'basic'
  'standard'
])
param searchSku string = 'standard'

@description('Knowledge base LLM for query planning and answer synthesis.')
param chatModel modelDeployment

@description('LLM that Content Understanding uses to describe charts and figures while indexing.')
param extractionModel modelDeployment

@description('Embedding model for chunk vectors and the query-time vectorizer.')
param embeddingModel modelDeployment

@description('Python version for the Function App.')
param pythonVersion string = '3.12'

@secure()
@description('Function key the web app uses to call the API. scripts/deploy.ps1 reads it from the existing Function App; empty on a first deployment.')
param functionAppKey string = ''

@description('Region for the web app (UI + /api proxy only). Defaults to the main region.')
param webAppLocation string = location

@description('Client ID of the web app\'s sign-in app registration (scripts/setup_web_auth.py). Empty leaves sign-in off.')
param webAuthClientId string = ''

var tags = {
  project: 'osfi-rag-poc'
  environment: environmentName
}
var token = toLower(uniqueString(subscription().id, environmentName, location))
var compactName = toLower(replace(environmentName, '-', ''))
var deploymentContainerName = 'function-releases'
var stagingContainerName = 'staging'
var syncStateContainerName = 'sync-state'

// Data-plane object names shared by scripts/setup_search.py and the Function App.
var searchObjects = {
  apiVersion: '2026-08-01-preview'
  dataSource: 'annual-reports-blob'
  index: 'annual-reports-chunks'
  // The indexer writes here; the SharePoint sync copies chunks into the chunk index with permissions.
  stagingIndex: 'annual-reports-staging'
  skillset: 'annual-reports-skillset'
  indexer: 'annual-reports-indexer'
  knowledgeSource: 'annual-reports-ks'
  knowledgeBase: 'annual-reports-kb'
  agentKnowledgeBase: 'annual-reports-agent-kb'
}

// Foundry agent (scripts/setup_agent.py) and the connection its knowledge base tool authenticates through.
var searchName = 'srch-${environmentName}-${token}'
var agentConfig = {
  name: 'osfi-annual-reports-agent'
  connection: 'annual-reports-kb-mcp'
  mcpEndpoint: 'https://${searchName}.search.windows.net/knowledgebases/${searchObjects.agentKnowledgeBase}/mcp?api-version=${searchObjects.apiVersion}'
}

resource rg 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module monitoring 'modules/monitoring.bicep' = {
  scope: rg
  params: {
    location: location
    tags: tags
    logAnalyticsName: 'log-${environmentName}-${token}'
    appInsightsName: 'appi-${environmentName}-${token}'
  }
}

module storage 'modules/storage.bicep' = {
  scope: rg
  params: {
    name: take('st${compactName}${token}', 24)
    location: location
    tags: tags
    containerNames: [
      deploymentContainerName
    ]
  }
}

// SharePoint sync: files pass through the staging container until indexed; the sync state lives beside them.
module staging 'modules/staging.bicep' = {
  scope: rg
  params: {
    name: take('stage${token}', 24)
    location: location
    tags: tags
    stagingContainerName: stagingContainerName
    stateContainerName: syncStateContainerName
  }
}

module search 'modules/search.bicep' = {
  scope: rg
  params: {
    name: searchName
    location: location
    tags: tags
    sku: searchSku
  }
}

module foundry 'modules/foundry.bicep' = {
  scope: rg
  params: {
    name: 'aif-${environmentName}-${token}'
    projectName: 'proj-${environmentName}'
    location: location
    tags: tags
    deployments: [
      chatModel
      extractionModel
      embeddingModel
    ]
    knowledgeBaseConnection: {
      name: agentConfig.connection
      target: agentConfig.mcpEndpoint
    }
    appInsightsName: monitoring.outputs.appInsightsName
  }
}

module functionApp 'modules/functionapp.bicep' = {
  scope: rg
  params: {
    name: 'func-${environmentName}-${token}'
    planName: 'plan-${environmentName}-${token}'
    identityName: 'id-func-${environmentName}-${token}'
    location: location
    tags: tags
    storageAccountName: storage.outputs.name
    deploymentContainerName: deploymentContainerName
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    pythonVersion: pythonVersion
    appSettings: {
      SEARCH_ENDPOINT: search.outputs.endpoint
      SEARCH_API_VERSION: searchObjects.apiVersion
      SEARCH_INDEX: searchObjects.index
      SEARCH_STAGING_INDEX: searchObjects.stagingIndex
      SEARCH_INDEXER: searchObjects.indexer
      KNOWLEDGE_SOURCE: searchObjects.knowledgeSource
      KNOWLEDGE_BASE: searchObjects.knowledgeBase
      STAGING_BLOB_ENDPOINT: staging.outputs.blobEndpoint
      STAGING_CONTAINER: stagingContainerName
      SYNC_STATE_CONTAINER: syncStateContainerName
      FOUNDRY_PROJECT_ENDPOINT: foundry.outputs.projectEndpoint
      AGENT_NAME: agentConfig.name
    }
  }
}

module rbac 'modules/rbac.bicep' = {
  scope: rg
  params: {
    foundryName: foundry.outputs.name
    searchName: search.outputs.name
    storageAccountName: storage.outputs.name
    stagingAccountName: staging.outputs.name
    searchPrincipalId: search.outputs.principalId
    functionPrincipalId: functionApp.outputs.principalId
    projectPrincipalId: foundry.outputs.projectPrincipalId
    userPrincipalId: principalId
    ciPrincipalId: ciPrincipalId
  }
}

// React UI (web/) plus a small Node server that proxies /api to the Function App with the function key and the
// signed-in user's Azure AI Search token.
module webApp 'modules/webapp.bicep' = {
  scope: rg
  params: {
    name: 'app-${environmentName}-${token}'
    planName: 'plan-web-${environmentName}-${token}'
    identityName: 'id-web-${environmentName}-${token}'
    location: webAppLocation
    tags: tags
    apiBaseUrl: functionApp.outputs.url
    apiKey: functionAppKey
    authClientId: webAuthClientId
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
  }
}

// Written to .env by scripts/deploy.ps1 and consumed by the other scripts.
output AZURE_SUBSCRIPTION_ID string = subscription().subscriptionId
output AZURE_TENANT_ID string = tenant().tenantId
output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_LOCATION string = location
output SEARCH_SERVICE_NAME string = search.outputs.name
output SEARCH_ENDPOINT string = search.outputs.endpoint
output SEARCH_API_VERSION string = searchObjects.apiVersion
output SEARCH_DATASOURCE string = searchObjects.dataSource
output SEARCH_INDEX string = searchObjects.index
output SEARCH_STAGING_INDEX string = searchObjects.stagingIndex
output SEARCH_SKILLSET string = searchObjects.skillset
output SEARCH_INDEXER string = searchObjects.indexer
output KNOWLEDGE_SOURCE string = searchObjects.knowledgeSource
output KNOWLEDGE_BASE string = searchObjects.knowledgeBase
output AGENT_KNOWLEDGE_BASE string = searchObjects.agentKnowledgeBase
output FOUNDRY_NAME string = foundry.outputs.name
output FOUNDRY_ENDPOINT string = foundry.outputs.servicesEndpoint
output AZURE_OPENAI_ENDPOINT string = foundry.outputs.openAiEndpoint
output FOUNDRY_PROJECT_NAME string = foundry.outputs.projectName
output FOUNDRY_PROJECT_ENDPOINT string = foundry.outputs.projectEndpoint
output AGENT_NAME string = agentConfig.name
output AGENT_CONNECTION string = foundry.outputs.knowledgeBaseConnectionName
output AGENT_MCP_ENDPOINT string = agentConfig.mcpEndpoint
output CHAT_DEPLOYMENT string = chatModel.name
output CHAT_MODEL string = chatModel.model
output EXTRACTION_DEPLOYMENT string = extractionModel.name
output EXTRACTION_MODEL string = extractionModel.model
output EMBEDDING_DEPLOYMENT string = embeddingModel.name
output EMBEDDING_MODEL string = embeddingModel.model
output STORAGE_ACCOUNT_NAME string = storage.outputs.name
output STORAGE_ACCOUNT_ID string = storage.outputs.id
output STAGING_STORAGE_ACCOUNT_NAME string = staging.outputs.name
output STAGING_STORAGE_ACCOUNT_ID string = staging.outputs.id
output STAGING_BLOB_ENDPOINT string = staging.outputs.blobEndpoint
output STAGING_CONTAINER string = stagingContainerName
output SYNC_STATE_CONTAINER string = syncStateContainerName
output FUNCTION_APP_NAME string = functionApp.outputs.name
output FUNCTION_APP_URL string = functionApp.outputs.url
output FUNCTION_PRINCIPAL_ID string = functionApp.outputs.principalId
output WEB_APP_NAME string = webApp.outputs.name
output WEB_APP_URL string = webApp.outputs.url
output WEB_IDENTITY_PRINCIPAL_ID string = webApp.outputs.identityPrincipalId
output WEB_IDENTITY_CLIENT_ID string = webApp.outputs.identityClientId
output WEB_AUTH_CLIENT_ID string = webAuthClientId
output APPLICATIONINSIGHTS_NAME string = monitoring.outputs.appInsightsName
