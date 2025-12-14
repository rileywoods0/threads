[CmdletBinding()]
param(
    [string]$BackendUrl = "http://localhost:8000",
    [string]$RootPath = ""
)

if (-not $RootPath) {
    $RootPath = (Resolve-Path "..").Path
}

Write-Host "== Threads backend E2E smoke ==" -ForegroundColor Cyan
Write-Host "Backend: $BackendUrl"
Write-Host "RootPath: $RootPath"

Write-Host "`n[1/6] Health"
Invoke-RestMethod -Uri "$BackendUrl/health" -Method Get | ConvertTo-Json -Depth 5

Write-Host "`n[2/6] Start session"
$startBody = @{ root_path = $RootPath; project_name = "threads-testing" } | ConvertTo-Json
$start = Invoke-RestMethod -Uri "$BackendUrl/session/start" -Method Post -ContentType "application/json" -Body $startBody
$sessionId = $start.session_id
Write-Host "SessionId: $sessionId"

Write-Host "`n[3/6] Post events"
$eventsBody = @{
    session_id = $sessionId
    events = @(
        @{ event_type = "editor.focus"; data = @{ filePath = "$RootPath\\testing\\src\\demo.py"; languageId = "python"; source = "vscode" } }
        @{ event_type = "file.save"; data = @{ filePath = "$RootPath\\testing\\src\\demo.py"; languageId = "python"; source = "vscode" } }
        @{ event_type = "debug.start"; data = @{ name = "demo"; type = "python"; source = "vscode" } }
        @{ event_type = "debug.end"; data = @{ name = "demo"; type = "python"; source = "vscode" } }
    )
} | ConvertTo-Json -Depth 8

Invoke-RestMethod -Uri "$BackendUrl/events" -Method Post -ContentType "application/json" -Body $eventsBody | ConvertTo-Json -Depth 8

Write-Host "`n[4/6] Create checkpoint snapshot (no session end)"
$checkpointBody = @{ session_id = $sessionId; reason = "smoke_test" } | ConvertTo-Json
$snapshot = Invoke-RestMethod -Uri "$BackendUrl/snapshot/create" -Method Post -ContentType "application/json" -Body $checkpointBody
$snapshotId = $snapshot.id
Write-Host "SnapshotId: $snapshotId"

Write-Host "`n[5/6] Fetch latest snapshot for project"
$latest = Invoke-RestMethod -Uri "$BackendUrl/project/latest_snapshot?root_path=$([uri]::EscapeDataString($RootPath))" -Method Get
$latest | ConvertTo-Json -Depth 8

Write-Host "`n[6/6] List snapshots + fetch by id"
$encoded = [uri]::EscapeDataString($RootPath)
$list = Invoke-RestMethod -Uri "$BackendUrl/project/snapshots?root_path=$encoded&limit=5" -Method Get
$list | ConvertTo-Json -Depth 8

if ($snapshotId) {
    $one = Invoke-RestMethod -Uri "$BackendUrl/snapshot/$snapshotId" -Method Get
    $one | ConvertTo-Json -Depth 8
}

Write-Host "`nOK" -ForegroundColor Green
