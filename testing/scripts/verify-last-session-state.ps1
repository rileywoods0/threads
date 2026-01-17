param(
  [string]$WorkspacePath = (Get-Location).Path
)

$statePath = Join-Path $WorkspacePath ".threads\last-session-state.json"
if (-not (Test-Path $statePath)) {
  Write-Error "Missing state file: $statePath"
  exit 1
}

try {
  $state = Get-Content -Path $statePath -Raw | ConvertFrom-Json
} catch {
  Write-Error "Failed to parse $statePath"
  exit 1
}

$missing = @()
if (-not $state.savedAt) { $missing += "savedAt" }
if (-not $state.files) { $missing += "files" }
if ($missing.Count -gt 0) {
  Write-Error ("State missing fields: {0}" -f ($missing -join ", "))
  exit 1
}

function Get-AnchorFile($state) {
  if ($state.activeFile) { return $state.activeFile }
  if ($state.openEditors -and $state.openEditors.Count -gt 0) { return $state.openEditors[0].filePath }
  if ($state.openFiles -and $state.openFiles.Count -gt 0) { return $state.openFiles[0] }
  if ($state.files -and $state.files.Count -gt 0) { return $state.files[0] }
  return $null
}

$anchor = Get-AnchorFile $state
$cursor = $null
if ($anchor -and $state.cursors) {
  $cursorProp = $state.cursors.PSObject.Properties | Where-Object { $_.Name -eq $anchor } | Select-Object -First 1
  if ($cursorProp) {
    $cursor = $cursorProp.Value
  }
}

$line = $null
$col = $null
if ($cursor) {
  if ($cursor.active) {
    $line = $cursor.active.line + 1
    $col = $cursor.active.character + 1
  } elseif ($cursor.line -ne $null) {
    $line = $cursor.line + 1
    $col = $cursor.character + 1
  }
}

Write-Host "SavedAt: $($state.savedAt)"
Write-Host "Files recorded: $($state.files.Count)"
Write-Host ("Active file: {0}" -f ($state.activeFile ?? "(none)"))
Write-Host ("Anchor file: {0}" -f ($anchor ?? "(none)"))
if ($line -and $col) {
  Write-Host "Last position: Line $line, Col $col"
} else {
  Write-Host "Last position: (none)"
}
