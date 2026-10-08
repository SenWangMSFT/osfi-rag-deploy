@description('Region for the monitoring resources.')
param location string

@description('Tags applied to every resource.')
param tags object

@description('Log Analytics workspace name.')
param logAnalyticsName string

@description('Application Insights component name.')
param appInsightsName string

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2026-03-01' = {
  name: logAnalyticsName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

output appInsightsName string = appInsights.name
output appInsightsConnectionString string = appInsights.properties.ConnectionString
