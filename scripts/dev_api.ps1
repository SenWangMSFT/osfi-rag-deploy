<#
.SYNOPSIS
  Runs the Function App locally (http://localhost:7071) against the deployed Azure resources.
.DESCRIPTION
  Uses the repo's .venv and your az login identity (the same data-plane roles the setup scripts use).
  Function keys aren't enforced locally. Pair it with ./scripts/dev_web.ps1 -LocalApi.
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$settings = Join-Path $root 'src/function_app/local.settings.json'
if (-not (Test-Path $settings)) { throw "Missing $settings - run ./scripts/deploy.ps1 -OutputsOnly first." }
if (-not (Get-Command func -ErrorAction SilentlyContinue)) { throw 'Azure Functions Core Tools (func) is not installed.' }

& (Join-Path $root '.venv/Scripts/Activate.ps1')
Push-Location (Join-Path $root 'src/function_app')
try {
    func start
}
finally {
    Pop-Location
}
