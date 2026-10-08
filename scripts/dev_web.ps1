<#
.SYNOPSIS
  Runs the React app locally.
.DESCRIPTION
  By default /api calls go to the deployed Function App, with its key added by the dev server (the key never
  reaches the browser). -LocalApi sends them to a local Functions host instead (./scripts/dev_api.ps1).
  -Production builds the app and runs web/server.mjs, the same server the web app runs in Azure.
  There's no sign-in locally: the server forwards your az login identity's Azure AI Search token as the user's, so
  you see exactly the institutions your groups can see.
.EXAMPLE
  ./scripts/dev_web.ps1                         # UI with hot reload on http://localhost:5173, API in Azure
  ./scripts/dev_web.ps1 -LocalApi               # UI and API both local
  ./scripts/dev_web.ps1 -Production             # production build on http://localhost:8080
#>
[CmdletBinding()]
param(
    [switch]$LocalApi,
    [switch]$Production
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
. (Join-Path $PSScriptRoot '_env.ps1')

if ($LocalApi) {
    $env:API_BASE_URL = 'http://localhost:7071'
    $env:API_KEY = ''
    Write-Host 'API: local Functions host on http://localhost:7071 (start it with ./scripts/dev_api.ps1)'
}
else {
    $env:API_BASE_URL = $cfg.FUNCTION_APP_URL
    $env:API_KEY = az functionapp keys list -g $cfg.AZURE_RESOURCE_GROUP -n $cfg.FUNCTION_APP_NAME `
        --query functionKeys.default -o tsv
    if (-not $env:API_KEY) { throw 'Could not read the function key.' }
    Write-Host "API: $($cfg.FUNCTION_APP_URL)"
}

Push-Location (Join-Path (Split-Path -Parent $PSScriptRoot) 'web')
try {
    $env:LOCAL_USER_TOKEN = 'az'
    if (-not (Test-Path node_modules)) { npm ci --no-audit --no-fund }
    if ($Production) {
        npm run build
        $env:PORT = '8080'
        npm start
    }
    else {
        npm run dev
    }
}
finally {
    Pop-Location
    Remove-Item Env:API_KEY, Env:API_BASE_URL, Env:PORT, Env:LOCAL_USER_TOKEN -ErrorAction SilentlyContinue
}
