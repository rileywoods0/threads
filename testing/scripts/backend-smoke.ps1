[CmdletBinding()]
param(
    [string]$BackendUrl = "http://localhost:8000",
    [string]$RootPath = ""
)

if (-not $RootPath) {
    $RootPath = (Resolve-Path "..").Path
}

Write-Host "Health check at $BackendUrl/health"
Invoke-RestMethod -Uri "$BackendUrl/health" -Method Get

$payload = @{
    root_path    = $RootPath
    project_name = "threads-testing"
}

Write-Host "Starting session for $RootPath"
$start = Invoke-RestMethod -Uri "$BackendUrl/session/start" -Method Post -ContentType "application/json" -Body ($payload | ConvertTo-Json)
Write-Host "Session start response:" ($start | ConvertTo-Json -Depth 4)
