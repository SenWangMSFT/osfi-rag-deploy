using 'main.bicep'

param environmentName = 'osfi-rag-poc'
param location = 'canadacentral'
param searchSku = 'standard'

// canadaeast keeps the UI in Canada when the subscription has no App Service quota in canadacentral.
param webAppLocation = 'canadaeast'

// Set by scripts/deploy.ps1 from `az ad signed-in-user show`, unless AZURE_PRINCIPAL_ID is already set.
param principalId = readEnvironmentVariable('AZURE_PRINCIPAL_ID', '')

// Optional identity of a CI/CD pipeline. Empty when deploying by hand.
param ciPrincipalId = readEnvironmentVariable('CI_PRINCIPAL_ID', '')

// Set by scripts/deploy.ps1 from the existing Function App (empty on a first deployment).
param functionAppKey = readEnvironmentVariable('FUNCTION_APP_KEY', '')

// App registration for user sign-in, created by scripts/setup_web_auth.py. scripts/deploy.ps1 carries it over from
// the previous deployment; empty leaves sign-in off.
param webAuthClientId = readEnvironmentVariable('WEB_AUTH_CLIENT_ID', '')

// In canadacentral these models are offered as GlobalStandard only (inference isn't region-pinned).
param chatModel = {
  name: 'gpt-5-6-sol'
  model: 'gpt-5.6-sol'
  version: '2026-07-09'
  sku: 'GlobalStandard'
  capacity: 250
}

// Content Understanding's supported-model list stops at gpt-5.5, so figure descriptions use it.
param extractionModel = {
  name: 'gpt-5-5'
  model: 'gpt-5.5'
  version: '2026-04-24'
  sku: 'GlobalStandard'
  capacity: 150
}

param embeddingModel = {
  name: 'text-embedding-3-large'
  model: 'text-embedding-3-large'
  version: '1'
  sku: 'GlobalStandard'
  capacity: 350
}
