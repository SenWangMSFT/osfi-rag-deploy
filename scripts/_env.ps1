# Dot-source to load the deployment outputs: . "$PSScriptRoot/_env.ps1"; $cfg.SEARCH_ENDPOINT
$envFile = Join-Path (Split-Path -Parent $PSScriptRoot) '.env'
if (-not (Test-Path $envFile)) { throw "Missing $envFile - run scripts/deploy.ps1 first." }
$cfg = @{}
foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Za-z0-9_]+)=(.*)$') { $cfg[$Matches[1]] = $Matches[2].Trim() }
}
