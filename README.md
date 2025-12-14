# Threads Prototype (Supabase)

Threads is a developer memory prototype with a FastAPI backend (Supabase storage) and a VS Code extension that captures IDE activity to build lightweight memory snapshots.

## Repository Layout
- `backend/` - FastAPI app, Supabase client, memory heuristics, and SQL schema.
- `vscode-extension/` - VS Code extension that captures editor events and renders the latest memory snapshot.

## Supabase Setup
1. Create (or reuse) a Supabase project.
2. Apply the schema in `backend/supabase_schema.sql` via the SQL editor.
3. Copy `.env.example` to `.env` in the repo root and fill in values:
   ```bash
   SUPABASE_URL=<your project url>
   # Use ONE of these (secret/service role recommended for backend writes)
   SUPABASE_SECRET_KEY=<sb_secret_...>
   # SUPABASE_SERVICE_ROLE_KEY=<legacy JWT service_role>
   # SUPABASE_KEY=<generic fallback>
   API_HOST=0.0.0.0
   API_PORT=8000
   ```
   The backend reads these automatically (see `backend/config.py`). Keep keys out of version control.

## Backend
### Install (use a virtualenv)
```bash
cd backend
python -m venv .venv
. .venv/Scripts/activate   # Windows
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

### Run the API
From the repository root:
```bash
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```
If running from inside `backend/`, set `PYTHONPATH=..`.

### Quick Checks
```bash
Invoke-RestMethod -Uri "http://localhost:8000/session/start" -Method POST -ContentType "application/json" -Body '{"root_path":"C:/Github/threads","project_name":"threads"}'
```

### What to Expect
- Each request logs to stdout (session start/end, event batches, Supabase errors).
- After `/session/start`, you should see new rows in `projects` and `sessions`.
- After sending `/events` and `/session/end`, you should see rows in `events` and `memory_snapshots`.
- `/snapshot/create` creates a checkpoint snapshot without ending the session.

## VS Code Extension
### Install & Build
```bash
cd vscode-extension
npm install
npm run compile
```

### In-Editor UI
- Open the **Threads** view in the Activity Bar to access common actions (resume, browse snapshots, open summary markdown, health check).
- The status bar shows `Threads: In session`; clicking it opens a quick action menu (resume, show last session, save state, browse snapshots, export bundle, diagnostics).
- The snapshot panel includes a primary **Copy for LLM** button with Compact/Debug/Deep modes.
- Use **Threads: Export Context Bundle (Markdown)** to generate `.threads/context-bundle.md` for pasting into Copilot/Claude/ChatGPT on project reopen.
- Use **Threads: Resume Where I Left Off** to reopen the exact files you touched last session.
  - Best-effort restores cursor + editor column and reveals the anchor file in the Explorer.
- Use **Threads: Send Feedback** to open/copy a prefilled template (no secrets, no code).
- Optional: set `threads.startup.openSnapshotPanel` to `longBreak` or `always` to auto-open the snapshot panel on workspace open (can be disruptive).

### Debug Workflow
1. Open `vscode-extension` in VS Code and press `F5` to launch the Extension Development Host.
2. In the dev host, open the Threads repo workspace.
3. Confirm the status bar shows `Threads` (clicking opens the latest snapshot).
4. Make edits, change active files, and start/stop the debugger to queue events.
5. Use **Threads: Save State Now** to end the current session, create a snapshot, and start a new one. This also writes `.threads/last-session.md` so AI assistants can pick up prior context.
6. Use **Threads: Show Last State** to open the webview with the most recent snapshot (copy the summary to clipboard from the panel) or **Threads: Open Last Summary Markdown** to view the markdown file directly.
7. Use **Threads: Browse Snapshots** to open older snapshots from history.

Backend logs should show `/session/start`, `/events`, `/session/end`, and `/project/latest_snapshot` calls. Supabase tables should update accordingly.

## Testing & Verification Guide
- **Backend only:**
  1. Start Uvicorn as above.
  2. Hit `/health` and `/session/start`.

     PowerShell:
     ```powershell
     Invoke-RestMethod -Uri "http://localhost:8000/health" -Method Get
     Invoke-RestMethod -Uri "http://localhost:8000/session/start" -Method Post -ContentType "application/json" -Body '{"root_path":"C:/Github/threads","project_name":"threads"}'
     ```

     Note: in PowerShell, `curl` is an alias for `Invoke-WebRequest` (not curl.exe). Use `Invoke-RestMethod` for JSON APIs.
  3. Post an events batch:
     ```powershell
     Invoke-RestMethod -Uri "http://localhost:8000/events" -Method Post -ContentType "application/json" -Body '{"session_id":"<id from start>","events":[{"event_type":"file_edit","data":{"filePath":"C:/Github/threads/testing/src/demo.py"}}]}'
     ```
  4. Create a checkpoint snapshot (does not end session):
     ```powershell
     Invoke-RestMethod -Uri "http://localhost:8000/snapshot/create" -Method Post -ContentType "application/json" -Body '{"session_id":"<id>","reason":"manual"}'
     ```
  5. End the session:
     ```powershell
     Invoke-RestMethod -Uri "http://localhost:8000/session/end" -Method Post -ContentType "application/json" -Body '{"session_id":"<id>"}'
     ```
  6. Check Supabase Dashboard tables (`projects`, `sessions`, `events`, `memory_snapshots`) for new rows.
- **Extension + backend:** follow the debug workflow above and watch backend logs for the incoming requests.
- **Testing workspace:** open `testing/` in the Extension Development Host and follow `testing/CHECKLIST.md` for a full end-to-end verification flow.

## Troubleshooting
- **TypeScript timer typing errors:** ensure `flushTimer` is typed as `NodeJS.Timeout | undefined` (see `src/extension.ts`).
- **No requests hitting backend:** verify `threads.backendUrl` in VS Code settings and confirm `Invoke-RestMethod -Uri "http://localhost:8000/health" -Method Get` succeeds.
- **No Supabase writes:** confirm `.env` values are loaded; backend logs will print Supabase errors to the console.
- **Webview not updating:** use **Threads: Save State Now** to flush events and create a snapshot, then re-open **Threads: Show Last State**.

## Notes
- Secrets stay in your local `.env`; none are committed.
- Memory snapshots are heuristic (no LLM calls) so they remain fast and predictable.

## Naming
Threads is a working name. If you need a safer/product-clarity alternative, consider: Threadline, Flowline, Handoff, Continuum, Threaded, or ResumePoint.

## Icon
The activity bar icon is configured in `vscode-extension/package.json` under `contributes.viewsContainers.activitybar[0].icon` and points at `vscode-extension/media/icon-flowmark.svg` (swap to another SVG in `vscode-extension/media/` if you prefer).
