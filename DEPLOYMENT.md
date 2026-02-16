# Deployment

This document covers publishing the VS Code extension and optionally hosting the backend.

## VS Code Marketplace (extension)
1. Build the extension:
   ```bash
   cd vscode-extension
   npm install
   npm run compile
   ```
2. Package and publish with `vsce`:
   ```bash
   npm install -g @vscode/vsce
   vsce package
   ```
3. Create a publisher + Personal Access Token (PAT) in Azure DevOps and login once:
   ```bash
   vsce login <your-publisher-id>
   ```
4. Publish:
   ```bash
   vsce publish patch
   ```
5. Verify listing metadata:
   - Extension icon renders correctly
   - README sections show local-first quick start
   - Commands and settings are discoverable in Marketplace page

Local mode is the default, so end users do not need a backend to get value immediately.

## Optional hosted backend (remote mode)
Remote mode is opt-in (`threads.runtimeMode = remote`). Host the FastAPI backend if you want Supabase sync.

### Recommended platforms
- Fly.io
- Render
- Railway

### Environment variables
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (recommended)
- `API_HOST` (default `0.0.0.0`)
- `API_PORT` (default `8000`)

### Running locally
```bash
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

### Security posture
- Local mode stores data in `threads.dataDir` (default `${workspaceFolder}/.threads`).
- LLM keys are stored in VS Code SecretStorage only.
- No code content is sent to LLMs by default.
- Remote sync is optional; users must explicitly enable it.

### Pre-release checklist
- `npm run compile` passes in `vscode-extension/`.
- `Threads: Run Smoke Test` passes in local mode.
- Optional: remote-mode smoke (`testing/scripts/backend-smoke.ps1`) passes.
- Optional: LLM handoff scenario (`testing/SCENARIO_LLM_HANDOFF.md`) passes.

## Suggested next steps
- Add usage analytics only if opt-in and privacy-reviewed.
- Provide a hosted backend URL for teams that want shared memory.
