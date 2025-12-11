# Threads Prototype (Supabase)

Threads is a lightweight developer memory prototype with a FastAPI backend backed by Supabase and a VS Code extension that captures local activity.

## Repository Layout
- `backend/` – FastAPI app, Supabase client, memory heuristics, and SQL schema.
- `vscode-extension/` – VS Code extension that captures editor events and renders the latest memory snapshot.

## Supabase Setup
1. Create a Supabase project (or reuse the provided one).
2. Run the SQL in `backend/supabase_schema.sql` to create the required tables:
   - `projects`
   - `sessions`
   - `events`
   - `memory_snapshots`
3. Configure environment variables (a `.env` file is supported):
   ```bash
   SUPABASE_URL=https://dffscxoafddkvrufdvyi.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRmZnNjeG9hZmRka3ZydWZkdnlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU0MTU1NTgsImV4cCI6MjA4MDk5MTU1OH0.9VU0WImp606m_wO86DVn1F-XziosAYtFunnkZpKd1Qg
   API_HOST=0.0.0.0
   API_PORT=8000
   ```

## Backend
### Install (use a virtualenv to avoid dependency conflicts)
```bash
cd backend
python -m venv .venv
. .venv/Scripts/activate   # Windows
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

### Run the API
Run from the repository root so the `backend` package is importable:
```bash
cd ..
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```
If you prefer running from inside `backend/`, add the project root to `PYTHONPATH`:
```bash
set PYTHONPATH=.. && uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

### Quick API Check
```bash
curl http://localhost:8000/health
curl -X POST http://localhost:8000/session/start -H "Content-Type: application/json" ^
  -d "{\"root_path\":\"C:/Github/threads\",\"project_name\":\"threads\"}"
```
Endpoints:
- `POST /session/start` – upsert project by `root_path` and start a session.
- `POST /events` – batch insert IDE events for a session.
- `POST /session/end` – mark session ended and write a heuristic memory snapshot.
- `GET /project/latest_snapshot?root_path=...` – fetch the most recent snapshot for a project.
- `GET /health` – readiness probe.

## VS Code Extension
### Install dependencies
```bash
cd vscode-extension
npm install
```

### Build and Debug
1. Run `npm run compile` (or `npm run watch`).
2. Open the `vscode-extension` folder in VS Code.
3. Press `F5` to launch an Extension Development Host.

### Behavior
- On activation, the extension detects the workspace root and calls `POST /session/start` on the backend.
- Captures events (save, active editor changes, debug start/stop) and batches them to `POST /events` every 5 seconds.
- On shutdown or the `Threads: Save State Now` command, pending events are flushed and `POST /session/end` is called.
- `Threads: Show Last State` opens a webview that renders the most recent snapshot from `GET /project/latest_snapshot`.

## Example Workflow
1. Start the backend: `uvicorn backend.main:app --reload`.
2. Open a project in VS Code and run the extension in debug mode.
3. Work normally; events are captured and persisted in Supabase.
4. Run `Threads: Show Last State` to view the current memory snapshot at any time.
