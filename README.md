# Threads

Threads is a developer memory prototype with a VS Code extension that captures IDE activity to build lightweight memory snapshots. By default it runs fully local, with optional Supabase sync for advanced users.

## Repository Layout
- `backend/` - Optional FastAPI app, Supabase client, memory heuristics, and SQL schema (remote mode only).
- `vscode-extension/` - VS Code extension that captures editor events and renders the latest memory snapshot.

## Quick start (2 minutes, local-only)
1. Install dependencies and build the extension:
   ```bash
   cd vscode-extension
   npm install
   npm run compile
   ```
2. Press `F5` in `vscode-extension/` to launch the Extension Development Host.
3. Open any workspace and start working. Threads captures context immediately (no backend required).
4. Use **Threads: Save State Now** to generate a snapshot and open the panel.

## Optional: Enhance with AI (privacy-first)
Run **Threads: Enhance with AI (Optional)** (this sets `threads.llm.enabled = true`):
- **Ollama (local)**: set `threads.llm.ollamaUrl` + `threads.llm.ollamaModel`.
- **OpenAI (BYO key)**: key is stored in VS Code SecretStorage (never written to disk).
- Reliability controls: `threads.llm.requestTimeoutMs` and `threads.llm.maxRetries`.

## Advanced: Supabase sync (remote mode)
1. Create (or reuse) a Supabase project.
2. Apply the schema in `backend/supabase_schema.sql` via the SQL editor.
3. Copy `.env.example` to `.env` in the repo root and fill in values (use the **service_role** key from Project Settings > API, not the JWT secret or database connection string):
   ```bash
   SUPABASE_URL=<your project url>
   SUPABASE_SERVICE_ROLE_KEY=<service_role JWT key>
   API_HOST=0.0.0.0
   API_PORT=8000
   ```
4. Run the API from the repository root:
   ```bash
   uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
   ```
5. Set `threads.runtimeMode = remote` and `threads.remote.backendUrl = http://localhost:8000`.

## VS Code Extension
### Install & Build
```bash
cd vscode-extension
npm install
npm run compile
```

### In-Editor UI
- Open the **Threads** view in the Activity Bar to access common actions (resume, browse snapshots, open summary markdown, health check).
- The status bar shows `Threads: In session`; clicking it opens the last snapshot panel. The Threads sidebar exposes structured sections (Resume, Continue, History, Settings & Tools).
- The snapshot panel includes a compact **Start here** block (anchor file, next step, and actions). **Copy for LLM** offers Compact/Debug-focused/Deep context formats, and **Continue with AI** provides a single-step handoff.
- Use **Threads: Export Context Bundle (Markdown)** to generate `.threads/context-bundle.md` for pasting into Copilot/Claude/ChatGPT on project reopen.
- Use **Threads: Resume Where I Left Off** to reopen the exact files you touched last session.
  - Best-effort restores active editor focus, cursor/selection, and editor column.
- Use **Threads: Send Feedback** to open/copy a prefilled template (no secrets, no code).
- `threads.startup.openSnapshotPanel` defaults to `longBreak` to reopen the snapshot panel after time away (set to `off` if you prefer zero auto-panels).
- Use **Threads: Open Data Folder** to see local snapshots/exports and **Threads: Delete Local Data** to clear everything.
- Use **Threads: Run Smoke Test** for one-click validation.

### Debug Workflow
1. Open `vscode-extension` in VS Code and press `F5` to launch the Extension Development Host.
2. In the dev host, open the Threads repo workspace.
3. Confirm the status bar shows `Threads` (clicking opens the latest snapshot).
4. Make edits, change active files, and start/stop the debugger to queue events.
5. Use **Threads: Save State Now** to end the current session, create a snapshot, and start a new one. This also writes `.threads/last-session.md` so AI assistants can pick up prior context.
6. Use **Threads: Show Last State** to open the webview with the most recent snapshot (copy the summary to clipboard from the panel) or **Threads: Open Last Summary Markdown** to view the markdown file directly.
7. Use **Threads: Browse Snapshots** to open older snapshots from history.

Backend logs should show `/session/start`, `/events`, `/session/end`, and `/project/latest_snapshot` calls. Supabase tables should update accordingly.
If you are in local mode, no backend logs are required.

## Privacy (default-safe)
- Captured: file paths, editor focus/save events, task/debug start/stop metadata.
- Not captured by default: code content, `.env`/`.threads` files, or secrets.
- LLM usage is optional and off by default. Set `threads.llm.includeCodeSnippets=true` to opt into small snippets.
- Use `threads.llm.includeDiffStatsOnly`, `threads.llm.includeFilePaths`, `threads.llm.redactHomeDir`, and `threads.llm.maxFiles` to fine-tune handoffs.
- Local data lives under `threads.dataDir` (default `${workspaceFolder}/.threads`).
- Use **Threads: Delete Local Data** to wipe local state.

## Multi-project behavior
- Threads is local-first per workspace.
- In local mode, snapshot history is filtered by workspace root path, so different projects do not mix when using a shared data directory.
- Remote mode already scopes snapshot APIs by `root_path`.

## Testing & Verification Guide
- **Local-only (no backend):**
  - Use the Extension Development Host with the `testing/` workspace and follow `testing/CHECKLIST.md`.
- **One-click smoke test:**
  - Run **Threads: Run Smoke Test** and review the Output > Threads log for PASS/FAIL.
- **Backend only (remote mode):**
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
- **No requests hitting backend:** verify `threads.runtimeMode=remote` and `threads.remote.backendUrl` in VS Code settings, then confirm `Invoke-RestMethod -Uri "http://localhost:8000/health" -Method Get` succeeds.
- **No Supabase writes:** confirm `.env` values are loaded; backend logs will print Supabase errors to the console.
- **Webview not updating:** use **Threads: Save State Now** to flush events and create a snapshot, then re-open **Threads: Show Last State**.
- **Ollama `fetch failed` / `Headers Timeout Error`:**
  1. Confirm Ollama is running: `Invoke-RestMethod http://localhost:11434/api/tags`
  2. Warm model once: `ollama run <your-model>`
  3. Increase `threads.llm.requestTimeoutMs` (example: `180000`)
  4. Increase `threads.llm.maxRetries` (example: `2`)

## Notes
- Secrets stay in your local `.env`; none are committed.
- LLM keys are stored in VS Code SecretStorage (never written to disk).
- Local mode works without the backend; remote mode is optional.

## Naming
Threads is a working name. If you need a safer/product-clarity alternative, consider: Threadline, Flowline, Handoff, Continuum, Threaded, or ResumePoint.

## Icon
The activity bar icon is configured in `vscode-extension/package.json` under `contributes.viewsContainers.activitybar[0].icon` and points at `vscode-extension/media/icon-flowmark.svg` (swap to another SVG in `vscode-extension/media/` if you prefer).
