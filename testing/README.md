# Threads Extension Test Harness

Use this folder as a throwaway workspace inside the VS Code Extension Development Host to verify that the Threads extension and backend talk to each other end‑to‑end.

## Prereqs
- Backend running from repo root: `uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000`
- `.env` in the repo root with valid Supabase URL + service/secret key.
- VS Code Extension Development Host launched from `vscode-extension` via `npm run compile` -> F5.

## Quick test flow
1. In the Extension Development Host, open the `testing` folder as the workspace.
2. Confirm the status bar shows `Threads`.
3. Open and save any file in `testing/src/` (e.g., `demo.py`, `demo.ts`, `notes.md`) to emit `file_edit` and `file_focus` events.
4. Run the command **Threads: Save State Now** to end the current session and start a new one.
5. Run **Threads: Show Last State** to open the snapshot panel; you should see the files you touched and a summary. Use **Copy summary** to check clipboard handling.
6. Watch the backend logs for `/session/start`, `/events`, `/session/end`, `/project/latest_snapshot` and check Supabase tables for new rows.

## Optional: backend smoke check from this folder
```powershell
.\scripts\backend-smoke.ps1 -BackendUrl "http://localhost:8000" -RootPath (Resolve-Path "..")
```
This will hit `/health` and `/session/start` with the current repo path.

## Notes
- `.vscode/settings.json` here pins `threads.backendUrl` to `http://localhost:8000` and shortens the flush interval for faster feedback.
- The sample files in `src/` cover multiple languages to exercise event payloads.
