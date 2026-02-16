# Threads Manual Verification Checklist

This checklist is designed to confirm Threads end-to-end behavior with minimal guesswork.

## 0) Setup
- If testing remote mode: backend is running: `uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000`
- If testing remote mode: Supabase schema applied: `backend/supabase_schema.sql`
- If testing remote mode: `.env` exists in repo root and is loaded by backend.
- Extension compiled: from `vscode-extension/`, run `npm run compile`
- Launch Extension Development Host (EDH): open `vscode-extension/` -> `F5`
- In EDH, open the `testing/` folder as the workspace.
- Optional: set `threads.resume.longBreakHours` in `testing/.vscode/settings.json` for faster long-break tests.
- Optional: set `threads.runtimeMode` to `local` or `remote` depending on which flow you want to validate.

## 1) Health + connectivity
- If `threads.runtimeMode=remote`: run **Threads: Check Backend Health** -> should show `ok`.
- If `threads.runtimeMode=local`: **Threads: Check Backend Health** should say backend not required.
- Open **Output** panel -> select `Threads` output channel -> confirm logs show activation and event flushes.
- Click the status bar `Threads: In session` -> snapshot panel should open.

## 2) Capture signals (no noise)
- Open `testing/src/demo.py`, switch to `testing/src/demo.ts`, then back.
- Save both files once.
- Confirm `.threads/*` files are NOT included in captured \"files touched\" (Threads ignores `.threads/`).

## 3) Save + snapshot generation
- Run **Threads: Save State Now**
  - Expected:
    - A snapshot panel opens.
    - Supabase gets new rows in `sessions` (ended_at set) and `memory_snapshots`.
    - `.threads/last-session.md` exists and contains goal + next steps.
    - `.threads/last-session-state.json` exists and includes a `files` array.
    - Status bar tooltip shows \"Last checkpoint: ...\".

## 3b) Auto-checkpoint (interval/idle)
- Ensure `threads.autoCheckpoint.*` is enabled (testing workspace settings use short intervals).
- Do some activity: switch files + save a few times (aim for `minEvents`).
- Aim to exceed `threads.autoCheckpoint.minMeaningfulScore` (edits/debug/task runs contribute more than focus events).
- Wait:
  - **Idle trigger**: stop typing/changing editors for ~2 minutes.
  - **Interval trigger**: keep working for ~3 minutes after last checkpoint.
- Expected:
  - No panel pops automatically.
  - Status bar briefly shows \"checkpoint saved\".
  - Supabase gets a new row in `memory_snapshots` without ending the session.

## 4) Resume \"where I left off\"
- Close the editors you had open (optional).
- Run **Threads: Resume Where I Left Off**
  - Confirm it reopens the last touched/open files (may ask to open last 8 if there are many).
  - Confirm cursor positions restore for reopened files (best effort).
  - Confirm the active file is focused at the end (best effort).
  - Confirm the anchor/active file is revealed in the Explorer (best effort).
  - If you had multiple editor columns, confirm files reopen into the same columns (best effort).

## 5) History browsing
- Run **Threads: Browse Snapshots**
  - Pick an older snapshot.
  - Choose \"Open Snapshot Panel\" and confirm the panel updates.
  - Run again and choose \"Open Markdown\" to open `.threads/snapshots/<snapshot_id>.md`.

## 6) Context export (multi-mode)
- Run **Threads: Export Context Bundle (Markdown)**
  - Choose **Markdown file (Full)** -> expect `.threads/context-bundle.md` created and opened.
  - Choose **Copy for agent (Short)** -> paste into a scratch file; confirm it's compact.
  - Choose **Copy agent prompt (Opt-in)** -> paste into an AI tool; confirm it includes instructions + context.

## 6b) Copy for LLM (snapshot panel CTA)
- Open **Threads: Show Last State** and click **Copy for LLM**
  - Try **Compact (recommended)**: confirm it contains goal, anchor, recent actions, next steps, and open questions.
  - Try **Debug-focused**: confirm it includes runtime mode + last error (if any) without secrets.
  - Try **Deep context**: confirm it includes a small recent snapshot history block.

## 6c) Continue with AI (optional)
- Run **Threads: Enhance with AI (Optional)** or click **Continue with AI** in the sidebar.
- Confirm it copies a handoff without opening panels.
- If using Ollama and first request is slow, tune `threads.llm.requestTimeoutMs` and `threads.llm.maxRetries`.

## 6d) Redaction settings
- With `threads.export.redactHomeDir=true` (default), exported file paths should show `~` instead of your home directory.
- Toggle `threads.export.includeFilePaths=false` and confirm exports switch to file names only.

## 6e) Smart surfacing (long-break resume prompt)
- Lower `threads.resume.longBreakHours` (ex: `0.01`) in `testing/.vscode/settings.json` or run:
  ```powershell
  .\scripts\set-resume-test.ps1 -WorkspacePath (Get-Location).Path -LongBreakHours 0.01 -OpenSnapshotPanel longBreak -ResumeMode prompt
  ```
- Reload the window, then switch between 2+ files within ~45 seconds without saving.
- Expected:
  - A single prompt appears: \"Resume where you left off?\".
  - It does not show repeatedly in the same session.

## 7) Diagnostics
- Run **Threads: Diagnostics**
  - Confirm it shows: runtime mode, data path, backend URL (if remote), LLM status, pending events, last snapshot time/id, last backend error.

## 8) Run Smoke Test
- Run **Threads: Run Smoke Test**
- Confirm Output > Threads shows PASS/FAIL for each check.

## 8) Backend script smoke test (optional)
From repo root:
```powershell
.\testing\scripts\backend-e2e.ps1 -BackendUrl "http://localhost:8000" -RootPath (Resolve-Path ".").Path
```

## If something fails
- Check `Threads` Output channel (VS Code Output panel).
- Check backend terminal logs for Supabase errors.
- Confirm `threads.remote.backendUrl` (or legacy `threads.backendUrl`) in `testing/.vscode/settings.json`.
