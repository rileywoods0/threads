param(
  [string]$WorkspacePath = (Get-Location).Path,
  [int]$LongBreakHours = 1,
  [ValidateSet('off','longBreak','always')] [string]$OpenSnapshotPanel = 'longBreak',
  [ValidateSet('quiet','prompt','off')] [string]$ResumeMode = 'quiet'
)

$settingsPath = Join-Path $WorkspacePath ".vscode\settings.json"
$settingsDir = Split-Path -Parent $settingsPath

if (-not (Test-Path $settingsDir)) {
  New-Item -ItemType Directory -Path $settingsDir | Out-Null
}

$settings = @{}
if (Test-Path $settingsPath) {
  try {
    $settings = Get-Content -Path $settingsPath -Raw | ConvertFrom-Json
  } catch {
    Write-Warning "Existing settings.json is invalid; overwriting with new settings."
    $settings = @{}
  }
}

$settings.'threads.resume.longBreakHours' = $LongBreakHours
$settings.'threads.startup.openSnapshotPanel' = $OpenSnapshotPanel
$settings.'threads.resumeMode' = $ResumeMode

$settings | ConvertTo-Json -Depth 20 | Set-Content -Path $settingsPath

Write-Host "Updated $settingsPath"
Write-Host "threads.resume.longBreakHours = $LongBreakHours"
Write-Host "threads.startup.openSnapshotPanel = $OpenSnapshotPanel"
Write-Host "threads.resumeMode = $ResumeMode"
