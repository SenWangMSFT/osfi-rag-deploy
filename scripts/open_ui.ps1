<#
.SYNOPSIS
  Opens the web app (deploy it first with ./scripts/deploy_web.ps1).
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_env.ps1')
if (-not $cfg.WEB_APP_URL) { throw 'WEB_APP_URL is missing from .env - run ./scripts/deploy.ps1 first.' }
Start-Process $cfg.WEB_APP_URL
