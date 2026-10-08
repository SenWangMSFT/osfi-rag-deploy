@description('Web app name.')
param name string

@description('App Service plan name.')
param planName string

@description('Region.')
param location string

@description('Tags applied to every resource.')
param tags object

@description('Function App base URL that the web server proxies /api calls to.')
param apiBaseUrl string

@secure()
@description('Function key the web server adds to proxied /api calls. Empty on a first deployment; scripts/deploy_web.ps1 fills it in.')
param apiKey string = ''

@description('Application Insights connection string.')
param appInsightsConnectionString string

@description('App Service plan SKU. B1 is the smallest tier with Always On.')
param skuName string = 'B1'

@description('User-assigned identity the sign-in uses instead of a client secret (a federated credential on the app registration trusts it).')
param identityName string

@description('Client ID of the app registration for user sign-in (scripts/setup_web_auth.py). Empty leaves sign-in off, and the API then refuses every request.')
param authClientId string = ''

// The sign-in asks for an Azure AI Search token too; web/server.mjs forwards it so the API searches as the user.
var searchScope = 'https://search.azure.com/user_impersonation'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: identityName
  location: location
  tags: tags
}

resource plan 'Microsoft.Web/serverfarms@2025-03-01' = {
  name: planName
  location: location
  tags: tags
  kind: 'linux'
  sku: {
    name: skuName
  }
  properties: {
    reserved: true
  }
}

resource site 'Microsoft.Web/sites@2025-03-01' = {
  name: name
  location: location
  tags: tags
  kind: 'app,linux'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    siteConfig: {
      linuxFxVersion: 'NODE|24-lts'
      // web/server.mjs serves the built React app and proxies /api; it has no npm dependencies.
      appCommandLine: 'node server.mjs'
      alwaysOn: true
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      appSettings: [
        {
          name: 'API_BASE_URL'
          value: apiBaseUrl
        }
        {
          name: 'API_KEY'
          value: apiKey
        }
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'false'
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsightsConnectionString
        }
        {
          name: 'ApplicationInsightsAgent_EXTENSION_VERSION'
          value: '~3'
        }
        {
          // Sign-in proves the app's identity with this managed identity instead of a client secret.
          name: 'OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID'
          value: identity.properties.clientId
        }
      ]
    }
  }
}

resource auth 'Microsoft.Web/sites/config@2025-03-01' = if (!empty(authClientId)) {
  parent: site
  name: 'authsettingsV2'
  properties: {
    platform: {
      enabled: true
    }
    globalValidation: {
      requireAuthentication: true
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
      excludedPaths: [
        '/healthz'
      ]
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: authClientId
          clientSecretSettingName: 'OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID'
          openIdIssuer: '${environment().authentication.loginEndpoint}${tenant().tenantId}/v2.0'
        }
        login: {
          loginParameters: [
            'scope=openid profile email offline_access ${searchScope}'
          ]
        }
        validation: {
          allowedAudiences: [
            'api://${authClientId}'
          ]
        }
      }
    }
    login: {
      tokenStore: {
        enabled: true
      }
    }
  }
}

// Deployments authenticate with Entra ID (az webapp deploy), so basic-auth publishing stays off.
resource ftpPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2025-03-01' = {
  parent: site
  name: 'ftp'
  properties: {
    allow: false
  }
}

resource scmPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2025-03-01' = {
  parent: site
  name: 'scm'
  properties: {
    allow: false
  }
}

output name string = site.name
output url string = 'https://${site.properties.defaultHostName}'
output identityPrincipalId string = identity.properties.principalId
output identityClientId string = identity.properties.clientId
