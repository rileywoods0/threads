# Scenario: LLM Handoff

## Setup
- Ensure Threads is running in local mode (default): `threads.runtimeMode = "local"`.
- Start Ollama locally and pull a model (example: `ollama run llama3.1`).
- Run **Threads: Configure LLM** and choose **Ollama**.

## Steps
1. Open `testing/src/demo.py` and make a small edit.
2. Run **Threads: Save State Now** to generate a snapshot.
3. Open **Threads: Show Last State**.
4. Click **Copy for LLM** and choose **Compact**.
5. Paste into a scratch file and inspect the output.
6. Confirm a handoff file exists in `.threads/exports/context-handoff-<timestamp>.md`.

## Expected
- Output starts with a 2–3 line prompt wrapper.
- Context includes Goal, Anchor, Recent actions, What changed, Open questions, Next step, Constraints.
- No code content is included by default.
- Home directory paths are redacted (`~`).
- If LLM fails, output still appears using heuristic content.

## Optional: OpenAI BYO key
- Run **Threads: Configure LLM** -> OpenAI.
- Provide a model and key.
- Run **Threads: Test LLM Connection** -> should return OK.

