<#
.SYNOPSIS
  Deploys the POC infrastructure (infra/main.bicep) and writes the outputs to .env and
  src/function_app/local.settings.json.
.EXAMPLE
  ./scripts/deploy.ps1 -WhatIfOnly   # preview changes
  ./scripts/deploy.ps1               # what-if, then deploy
  ./scripts/deploy.ps1 -OutputsOnly  # rewrite .env / local.settings.json from the last deployment
#>
[CmdletBinding()]
param(
    [string]$Location = 'canadacentral',
    [string]$DeploymentName = 'osfi-rag-poc',
    [switch]$WhatIfOnly,
    [switch]$OutputsOnly
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$root = Split-Path -Parent $PSScriptRoot
$paramFile = Join-Path $root 'infra/main.bicepparam'

$account = az account show -o json | ConvertFrom-Json
Write-Host "Subscription: $($account.name) ($($account.id))  Tenant: $($account.tenantId)"

# The CLI re-cases output names (AZURE_LOCATION -> azurE_LOCATION), so normalize them.
function Get-LastOutputs {
    $outputs = az deployment sub show --name $DeploymentName --query properties.outputs -o json | ConvertFrom-Json
    $values = [ordered]@{}
    foreach ($p in $outputs.PSObject.Properties) { $values[$p.Name.ToUpperInvariant()] = [string]$p.Value.value }
    $values
}

if ($OutputsOnly) {
    $values = Get-LastOutputs
}
else {
    # main.bicepparam grants this user data-plane roles for the setup scripts. A pipeline that signs in as a
    # service principal sets AZURE_PRINCIPAL_ID to the operator's ID instead.
    if (-not $env:AZURE_PRINCIPAL_ID -and $account.user.type -eq 'user') {
        $env:AZURE_PRINCIPAL_ID = az ad signed-in-user show --query id -o tsv
    }

    # The web app proxies /api with the Function key. Reuse the existing key so a redeploy doesn't blank the
    # setting; on a first deployment there's no Function App yet, and scripts/deploy_web.ps1 sets it.
    # The sign-in app registration (scripts/setup_web_auth.py) is carried over the same way.
    $env:FUNCTION_APP_KEY = ''
    try {
        $last = Get-LastOutputs 2>$null
        if (-not $env:WEB_AUTH_CLIENT_ID -and $last.WEB_AUTH_CLIENT_ID) { $env:WEB_AUTH_CLIENT_ID = $last.WEB_AUTH_CLIENT_ID }
        $env:FUNCTION_APP_KEY = az functionapp keys list -g $last.AZURE_RESOURCE_GROUP -n $last.FUNCTION_APP_NAME `
            --query functionKeys.default -o tsv 2>$null
    }
    catch { Write-Host 'No Function App yet; the web app gets its key from scripts/deploy_web.ps1.' }
    if ($env:GITHUB_ACTIONS -eq 'true' -and $env:FUNCTION_APP_KEY) { Write-Host "::add-mask::$env:FUNCTION_APP_KEY" }

    Write-Host "`n== what-if ==" -ForegroundColor Cyan
    try {
        az deployment sub what-if --name $DeploymentName --location $Location --parameters $paramFile --result-format ResourceIdOnly
        if ($WhatIfOnly) { return }

        Write-Host "`n== deploying (10-15 minutes) ==" -ForegroundColor Cyan
        az deployment sub create --name $DeploymentName --location $Location --parameters $paramFile --output none
    }
    finally {
        Remove-Item Env:FUNCTION_APP_KEY -ErrorAction SilentlyContinue
    }
    $values = Get-LastOutputs
}

$envFile = Join-Path $root '.env'
$values.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" } | Set-Content -Path $envFile -Encoding utf8
Write-Host "Wrote $envFile"

# Local runs use the same Azure resources, authenticated with az login. The SharePoint sync stays off locally: your
# az login identity can't read SharePoint, and it must not race the deployed sync over the shared state.
$localSettings = [ordered]@{
    IsEncrypted = $false
    Values      = [ordered]@{
        FUNCTIONS_WORKER_RUNTIME           = 'python'
        AzureWebJobsStorage__accountName   = $values.STORAGE_ACCOUNT_NAME
        'AzureWebJobs.sharepoint_sync.Disabled' = 'true'
        SEARCH_ENDPOINT                    = $values.SEARCH_ENDPOINT
        SEARCH_API_VERSION                 = $values.SEARCH_API_VERSION
        SEARCH_INDEX                       = $values.SEARCH_INDEX
        SEARCH_STAGING_INDEX               = $values.SEARCH_STAGING_INDEX
        SEARCH_INDEXER                     = $values.SEARCH_INDEXER
        KNOWLEDGE_SOURCE                   = $values.KNOWLEDGE_SOURCE
        KNOWLEDGE_BASE                     = $values.KNOWLEDGE_BASE
        STAGING_BLOB_ENDPOINT              = $values.STAGING_BLOB_ENDPOINT
        STAGING_CONTAINER                  = $values.STAGING_CONTAINER
        SYNC_STATE_CONTAINER               = $values.SYNC_STATE_CONTAINER
        FOUNDRY_PROJECT_ENDPOINT           = $values.FOUNDRY_PROJECT_ENDPOINT
        AGENT_NAME                         = $values.AGENT_NAME
    }
}
$localSettingsFile = Join-Path $root 'src/function_app/local.settings.json'
$localSettings | ConvertTo-Json -Depth 5 | Set-Content -Path $localSettingsFile -Encoding utf8
Write-Host "Wrote $localSettingsFile"

Write-Host "`nResource group: https://portal.azure.com/#@$($account.tenantId)/resource/subscriptions/$($values.AZURE_SUBSCRIPTION_ID)/resourceGroups/$($values.AZURE_RESOURCE_GROUP)/overview"
