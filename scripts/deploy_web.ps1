<#
.SYNOPSIS
  Builds the React app in web/ and deploys it, with its Node server, to the App Service web app.
.EXAMPLE
  ./scripts/deploy_web.ps1
#>
[CmdletBinding()]
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
. (Join-Path $PSScriptRoot '_env.ps1')
if (-not $cfg.WEB_APP_NAME) { throw 'WEB_APP_NAME is missing from .env - run ./scripts/deploy.ps1 first.' }
$rg = $cfg.AZURE_RESOURCE_GROUP
$web = Join-Path (Split-Path -Parent $PSScriptRoot) 'web'

Push-Location $web
try {
    if (-not $SkipBuild) {
        npm ci --no-audit --no-fund
        npm test
        npm run build
    }
}
finally {
    Pop-Location
}

# server.mjs has no dependencies, so the package is just the server and the build output.
$stage = Join-Path ([IO.Path]::GetTempPath()) "osfi-web-$([guid]::NewGuid().ToString('N'))"
$zip = "$stage.zip"
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    Copy-Item (Join-Path $web 'server.mjs'), (Join-Path $web 'package.json') -Destination $stage
    Copy-Item (Join-Path $web 'dist') -Destination (Join-Path $stage 'dist') -Recurse
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip)

    Write-Host "Deploying to $($cfg.WEB_APP_NAME)..."
    # A newly created site can reject the first deployment while it's still starting, so retry.
    foreach ($attempt in 1..3) {
        try {
            az webapp deploy -g $rg -n $cfg.WEB_APP_NAME --src-path $zip --type zip --clean true --restart true --output none
            break
        }
        catch {
            if ($attempt -eq 3) { throw }
            Write-Host "Deployment attempt $attempt failed; retrying in 30 s..."
            Start-Sleep -Seconds 30
        }
    }

    # On a first deployment Bicep ran before the Function App had a key. Set it only after deploying: changing a
    # setting restarts the site, and a restart that overlaps the deployment's own one leaves the deployment reported
    # as failed after 10 minutes, although the site is running.
    $current = az webapp config appsettings list -g $rg -n $cfg.WEB_APP_NAME --query "[?name=='API_KEY'].value | [0]" -o tsv
    if (-not $current) {
        Write-Host 'Setting API_KEY from the Function App (the site restarts once more)...'
        $key = az functionapp keys list -g $rg -n $cfg.FUNCTION_APP_NAME --query functionKeys.default -o tsv
        if ($env:GITHUB_ACTIONS -eq 'true') { Write-Host "::add-mask::$key" }
        az webapp config appsettings set -g $rg -n $cfg.WEB_APP_NAME --settings "API_KEY=$key" --output none
    }
}
finally {
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
}

Write-Host "`nWeb app: $($cfg.WEB_APP_URL)" -ForegroundColor Green
