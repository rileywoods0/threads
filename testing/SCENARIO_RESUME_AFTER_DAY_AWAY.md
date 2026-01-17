# Scenario: Resume after day away

## Setup
- Ensure a snapshot exists by running "Threads: Save State Now" at the end of a work session.
- Close VS Code and wait longer than `threads.resume.longBreakHours` (or temporarily set it to a small value for testing).

## Steps
1. Reopen the workspace in VS Code.
2. Open the Threads sidebar or run "Threads: Show Last State".
3. In the snapshot panel, review the Start here block.
4. Click "Resume workspace".
5. (Optional) Click "Copy for LLM" and select Compact.

## Expected
- Resume prompt behavior follows `threads.resumeMode` (quiet shows status only; prompt shows a single prompt).
- Start here shows the anchor file and the primary next step in a compact layout.
- Resume workspace reopens the last files in their original columns (best effort).
- Active editor focus returns to the last active file.
- Cursor/selection position is restored for reopened files (best effort).
- No panels auto-open or steal focus during auto-checkpoints.
- Copy for LLM shows 3 formats and produces paste-ready, redacted output.
