<#
.SYNOPSIS
  Publishes src/function_app to the Flex Consumption Function App (remote build).
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_env.ps1')

Push-Location (Join-Path (Split-Path -Parent $PSScriptRoot) 'src/function_app')
try {
    func azure functionapp publish $cfg.FUNCTION_APP_NAME --python
    if ($LASTEXITCODE -ne 0) { throw 'func publish failed' }
}
finally {
    Pop-Location
}
Write-Host "`nWeb UI: ./scripts/deploy_web.ps1 (after UI changes), then ./scripts/open_ui.ps1"
