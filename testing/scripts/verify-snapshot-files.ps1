param(
  [string]$WorkspacePath = (Get-Location).Path
)

$threadsDir = Join-Path $WorkspacePath ".threads"
$summaryPath = Join-Path $threadsDir "last-session.md"
$statePath = Join-Path $threadsDir "last-session-state.json"
$archiveDir = Join-Path $threadsDir "snapshots"

$errors = @()
if (-not (Test-Path $summaryPath)) {
  $errors += "Missing summary file: $summaryPath"
}
if (-not (Test-Path $statePath)) {
  $errors += "Missing state file: $statePath"
}

$latest = $null
if (Test-Path $archiveDir) {
  $latest = Get-ChildItem -Path $archiveDir -Filter *.md | Sort-Object LastWriteTime -Descending | Select-Object -First 1
}
if (-not $latest) {
  $errors += "No snapshot archive markdown found in $archiveDir"
}

if ($errors.Count -gt 0) {
  $errors | ForEach-Object { Write-Error $_ }
  exit 1
}

Write-Host "Summary: $summaryPath"
Write-Host "State: $statePath"
Write-Host "Latest snapshot: $($latest.FullName)"
