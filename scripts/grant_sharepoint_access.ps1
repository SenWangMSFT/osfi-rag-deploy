<#
.SYNOPSIS
  Tenant-admin steps for the SharePoint sync and for user sign-in. Run once, and again after adding sites to
  config/institutions.csv.
.DESCRIPTION
  Signs in to Microsoft Graph (Microsoft Graph PowerShell) as a Global Administrator, or as a Privileged Role
  Administrator who is also a SharePoint Administrator, and:
  1. gives the Function App's managed identity the Graph application permission Sites.Selected;
  2. grants that identity read access to each site in config/institutions.csv, found by site_id, else site_url, else
     the first group's own team site, and writes each site's real URL and ID back to the file;
  3. if the web app has a sign-in app registration (WEB_AUTH_CLIENT_ID, from scripts/setup_web_auth.py), grants
     tenant-wide consent for its delegated permissions: sign-in, and Azure AI Search on the user's behalf.
.EXAMPLE
  ./scripts/grant_sharepoint_access.ps1
  ./scripts/grant_sharepoint_access.ps1 -UseDeviceCode   # when no sign-in window appears (e.g. VS Code terminal)
#>
[CmdletBinding()]
param(
    [switch]$UseDeviceCode
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_env.ps1')
$registryFile = Join-Path (Split-Path -Parent $PSScriptRoot) 'config/institutions.csv'
$graphAppId = '00000003-0000-0000-c000-000000000000'
$searchAppId = '880da380-985e-4198-81b9-e05b1cc53158'

if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Authentication)) {
    Write-Host 'Installing Microsoft.Graph.Authentication for the current user...'
    Install-Module Microsoft.Graph.Authentication -Scope CurrentUser -Force -AllowClobber
}
Import-Module Microsoft.Graph.Authentication

Connect-MgGraph -TenantId $cfg.AZURE_TENANT_ID -NoWelcome -UseDeviceCode:$UseDeviceCode -Scopes @(
    'AppRoleAssignment.ReadWrite.All', 'Application.Read.All', 'Sites.FullControl.All', 'DelegatedPermissionGrant.ReadWrite.All')
Write-Host "Signed in to Microsoft Graph as $((Get-MgContext).Account)`n"

function Invoke-Graph([string]$Method, [string]$Path, $Body) {
    $request = @{ Method = $Method; Uri = "https://graph.microsoft.com/v1.0$Path"; OutputType = 'PSObject' }
    if ($null -ne $Body) {
        $request.Body = $Body | ConvertTo-Json -Depth 10
        $request.ContentType = 'application/json'
    }
    Invoke-MgGraphRequest @request
}

# 1. Graph application permission Sites.Selected for the Function App's managed identity.
$graphSp = Invoke-Graph GET "/servicePrincipals(appId='$graphAppId')?`$select=id,appRoles"
$sitesSelected = ($graphSp.appRoles | Where-Object value -EQ 'Sites.Selected').id
$identity = Invoke-Graph GET "/servicePrincipals/$($cfg.FUNCTION_PRINCIPAL_ID)?`$select=id,appId,displayName"
$roles = (Invoke-Graph GET "/servicePrincipals/$($identity.id)/appRoleAssignments").value
if ($roles | Where-Object { $_.appRoleId -eq $sitesSelected -and $_.resourceId -eq $graphSp.id }) {
    Write-Host "ok       Sites.Selected for $($identity.displayName)"
}
else {
    Invoke-Graph POST "/servicePrincipals/$($identity.id)/appRoleAssignments" @{
        principalId = $identity.id; resourceId = $graphSp.id; appRoleId = $sitesSelected
    } | Out-Null
    Write-Host "granted  Sites.Selected for $($identity.displayName)"
}

# 2. Read access on each registered site. A new Microsoft 365 group's site can take a few minutes to appear.
$rows = @(Import-Csv $registryFile)
foreach ($row in $rows) {
    $groupId = @($row.group_ids -split '[;\s]+' | Where-Object { $_ })[0]
    $site = $null
    for ($attempt = 1; -not $site; $attempt++) {
        try {
            $site = if ($row.site_id) { Invoke-Graph GET "/sites/$($row.site_id)?`$select=id,webUrl" }
            elseif ($row.site_url) {
                $url = [uri]$row.site_url
                Invoke-Graph GET "/sites/$($url.Host):$($url.AbsolutePath.TrimEnd('/'))?`$select=id,webUrl"
            }
            else { Invoke-Graph GET "/groups/$groupId/sites/root?`$select=id,webUrl" }
        }
        catch {
            if ($attempt -ge 10) { throw "No site for $($row.institution_key): $_" }
            Write-Host "  $($row.institution_key): site not ready yet; retrying in 30 s"
            Start-Sleep -Seconds 30
        }
    }
    $row.site_id = $site.id
    $row.site_url = $site.webUrl
    $grants = (Invoke-Graph GET "/sites/$($site.id)/permissions").value
    $granted = $grants | Where-Object {
        @($_.grantedToIdentitiesV2.application.id) + @($_.grantedToIdentities.application.id) -contains $identity.appId
    }
    if ($granted) {
        Write-Host "ok       read on $($site.webUrl)"
    }
    else {
        Invoke-Graph POST "/sites/$($site.id)/permissions" @{
            roles               = @('read')
            grantedToIdentities = @(@{ application = @{ id = $identity.appId; displayName = $identity.displayName } })
        } | Out-Null
        Write-Host "granted  read on $($site.webUrl)"
    }
}
$rows | Export-Csv $registryFile -NoTypeInformation -Encoding utf8 -UseQuotes AsNeeded
Write-Host "Updated $registryFile with each site's URL and ID."

# 3. Tenant-wide consent for the web app's sign-in.
if ($cfg.WEB_AUTH_CLIENT_ID) {
    $web = Invoke-Graph GET "/servicePrincipals(appId='$($cfg.WEB_AUTH_CLIENT_ID)')?`$select=id,displayName"
    $searchSp = Invoke-Graph GET "/servicePrincipals(appId='$searchAppId')?`$select=id"
    foreach ($grant in @(
            @{ resourceId = $graphSp.id; scope = 'openid profile email offline_access User.Read' }
            @{ resourceId = $searchSp.id; scope = 'user_impersonation' })) {
        $filter = [uri]::EscapeDataString("clientId eq '$($web.id)' and resourceId eq '$($grant.resourceId)'")
        $existing = (Invoke-Graph GET "/oauth2PermissionGrants?`$filter=$filter").value | Where-Object consentType -EQ 'AllPrincipals'
        if ($existing) {
            Invoke-Graph PATCH "/oauth2PermissionGrants/$($existing[0].id)" @{ scope = $grant.scope } | Out-Null
        }
        else {
            Invoke-Graph POST '/oauth2PermissionGrants' @{
                clientId = $web.id; consentType = 'AllPrincipals'; resourceId = $grant.resourceId; scope = $grant.scope
            } | Out-Null
        }
        Write-Host "consent  $($web.displayName): $($grant.scope)"
    }
}
else {
    Write-Host 'skip     sign-in consent (no WEB_AUTH_CLIENT_ID yet; run scripts/setup_web_auth.py, then deploy)'
}

Write-Host "`nNext: python scripts/onboard_sites.py (publishes the registry), then python scripts/sync.py --run"
