# Threads Extension Test Harness

Use this folder as a throwaway workspace inside the VS Code Extension Development Host to verify that the Threads extension and backend talk to each other end-to-end.

## Prereqs
- Local mode works without a backend (default).
- Optional: backend running from repo root for remote mode tests: `uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000`
- Optional: `.env` in the repo root with valid Supabase URL + service/role key if testing remote mode.
- VS Code Extension Development Host launched from `vscode-extension` via `npm run compile` -> F5.

## Quick test flow
1. In the Extension Development Host, open the `testing` folder as the workspace.
2. Confirm the status bar shows `Threads: In session`. Click it to open the snapshot panel. The Threads sidebar exposes structured sections (Resume, Continue, History, Settings & Tools).
3. Open and save any file in `testing/src/` (e.g., `demo.py`, `demo.ts`, `notes.md`) to emit `file_edit` and `file_focus` events.
4. Use **Threads: Save State Now** from the Command Palette (Ctrl+Shift+P) to end the session, generate a snapshot, and immediately start a new one. This also writes `.threads/last-session.md` in the workspace with a markdown summary that LLMs can ingest.
5. Use **Threads: Show Last State** to open the snapshot webview; verify sections and the buttons:
   - Resume workspace
   - Copy for LLM (choose a mode)
   - Continue with AI (optional)
   - Start here actions (open anchor / resume / copy for LLM)
6. Use **Threads: Open Last Summary Markdown** to open the generated `.threads/last-session.md` file.
7. Use **Threads: Browse Snapshots** to view older snapshots from history.
8. Run **Threads: Run Smoke Test** to validate local storage, checkpointing, and markdown outputs.
9. If `threads.runtimeMode=remote`, watch backend logs for `/session/start`, `/events`, `/session/end`, `/project/latest_snapshot` and check Supabase tables for new rows.
9. Optional: run **Threads: Export Context Bundle (Markdown)** to generate `.threads/context-bundle.md` (great to paste into an AI assistant when you return later).
10. Optional: run **Threads: Resume Where I Left Off** to reopen the exact files you touched last session (best-effort cursor + column restore, and reveals the anchor file in Explorer).
11. Optional: do nothing for a few minutes after activity; auto-checkpoint should create a snapshot without opening any panels.

## Quick settings toggles (testing workspace)
`testing/.vscode/settings.json` is the fastest way to tweak resume behavior:
- `threads.resume.longBreakHours`: lower this (ex: `0.01`) to force long-break prompts/panel quickly.
- `threads.startup.openSnapshotPanel`: set to `longBreak` (default) or `off`.
- `threads.resumeMode`: `quiet` (default), `prompt`, or `off`.

You can also use the helper script:
```powershell
.\scripts\set-resume-test.ps1 -WorkspacePath (Get-Location).Path -LongBreakHours 0.01 -OpenSnapshotPanel longBreak -ResumeMode prompt
```

> Tip: run commands from the Command Palette, not the Debug Console, to avoid syntax errors.

## Optional: backend smoke check from this folder
```powershell
.\scripts\backend-smoke.ps1 -BackendUrl "http://localhost:8000" -RootPath (Resolve-Path "..")
```
This will hit `/health` and `/session/start` with the current repo path.

## Quick verification scripts
```powershell
# Verify last-session-state.json fields + anchor position
.\scripts\verify-last-session-state.ps1 -WorkspacePath (Get-Location).Path

# Verify snapshot markdown files exist
.\scripts\verify-snapshot-files.ps1 -WorkspacePath (Get-Location).Path

# LLM formatting + redaction (run after npm run compile)
node .\scripts\llm-format-test.js
```

## VS Code tasks (PowerShell ExecutionPolicy Bypass)
Run via **Terminal > Run Task**:
- Threads: Verify last-session state
- Threads: Verify snapshot files
- Threads: Backend smoke (optional)

## Optional: backend end-to-end script
```powershell
.\scripts\backend-e2e.ps1 -BackendUrl "http://localhost:8000" -RootPath (Resolve-Path "..")
```
This runs: `/health` -> `/session/start` -> `/events` -> `/session/end` -> snapshot history endpoints.

## Notes
- `.vscode/settings.json` here pins `threads.remote.backendUrl` (and legacy `threads.backendUrl`) to `http://localhost:8000` and shortens the flush interval for faster feedback.
- `threads.resumeMode` defaults to `quiet` (no popups) - use the Threads sidebar or status bar to resume.
- If you see a `punycode` deprecation warning in the debug console, it is coming from a dependency and is safe to ignore.
- `threads.autoCheckpoint.*` is set to short values in this workspace so you can verify interval/idle triggers quickly.
- `threads.runtimeMode` defaults to `local` (no backend required). Switch to `remote` to test Supabase sync.
- The sample files in `src/` cover multiple languages to exercise event payloads.
- The markdown summary lives at `.threads/last-session.md` after you save a session - perfect to hand to Copilot/Cursor/Claude as context when reopening the project.
