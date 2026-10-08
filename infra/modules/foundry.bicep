import { modelDeployment } from '../types.bicep'

@description('Foundry (AIServices) account name; also used as the custom subdomain.')
param name string

@description('Foundry project name.')
param projectName string

@description('Region. Must support Content Understanding.')
param location string

@description('Tags applied to every resource.')
param tags object

@description('Model deployments, created one at a time.')
param deployments modelDeployment[]

@description('Project connection the Foundry agent uses to call the knowledge base MCP endpoint as the project identity.')
param knowledgeBaseConnection {
  @description('Connection name; the agent definition references it as project_connection_id.')
  name: string

  @description('Knowledge base MCP endpoint, including api-version.')
  target: string
}

@description('Existing Application Insights component in this resource group that receives the agent\'s server-side traces.')
param appInsightsName string

resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
}

resource account 'Microsoft.CognitiveServices/accounts@2026-07-01' = {
  name: name
  location: location
  tags: tags
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    // A custom subdomain is required for Entra ID auth, Content Understanding and projects.
    customSubDomainName: name
    allowProjectManagement: true
    publicNetworkAccess: 'Enabled'
    // Entra ID only; the tenant policy enforces this anyway.
    disableLocalAuth: true
  }
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2026-07-01' = {
  parent: account
  name: projectName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    displayName: 'OSFI annual reports RAG POC'
    description: 'Citation-grounded RAG over Canadian bank and credit-union annual reports.'
  }
}

// One at a time: the account rejects concurrent deployment operations.
@batchSize(1)
resource modelDeployments 'Microsoft.CognitiveServices/accounts/deployments@2026-07-01' = [
  for d in deployments: {
    parent: account
    name: d.name
    sku: {
      name: d.sku
      capacity: d.capacity
    }
    properties: {
      model: {
        format: 'OpenAI'
        name: d.model
        version: d.version
      }
      versionUpgradeOption: 'NoAutoUpgrade'
    }
    dependsOn: [
      project
    ]
  }
]

// The published Bicep types don't include the RemoteTool/ProjectManagedIdentity connection yet, hence any().
resource mcpConnection 'Microsoft.CognitiveServices/accounts/projects/connections@2025-10-01-preview' = {
  parent: project
  name: knowledgeBaseConnection.name
  properties: any({
    category: 'RemoteTool'
    authType: 'ProjectManagedIdentity'
    target: knowledgeBaseConnection.target
    audience: 'https://search.azure.com/'
    isSharedToAll: true
    metadata: {
      ApiType: 'Azure'
    }
  })
}

// Turns on Foundry's server-side tracing of agent runs (Agents > Traces in the portal). A project allows one.
resource appInsightsConnection 'Microsoft.CognitiveServices/accounts/projects/connections@2026-07-01' = {
  parent: project
  name: 'app-insights'
  properties: {
    category: 'AppInsights'
    authType: 'ApiKey'
    target: appInsights.id
    isSharedToAll: true
    credentials: {
      key: appInsights.properties.ConnectionString
    }
    metadata: {
      ApiType: 'Azure'
      ResourceId: appInsights.id
    }
  }
}

output name string = account.name
output id string = account.id
output servicesEndpoint string = 'https://${account.name}.services.ai.azure.com'
output openAiEndpoint string = 'https://${account.name}.openai.azure.com'
output projectName string = project.name
output projectEndpoint string = 'https://${account.name}.services.ai.azure.com/api/projects/${project.name}'
output projectPrincipalId string = project.identity.principalId
output knowledgeBaseConnectionName string = mcpConnection.name
