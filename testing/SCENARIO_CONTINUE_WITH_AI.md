# Scenario: Continue with AI

## Setup
- Ensure Threads is running in local mode (default): `threads.runtimeMode = "local"`.
- Have at least one snapshot (run **Threads: Save State Now**).

## Steps (first time)
1. Open the Threads sidebar and expand **Continue**.
2. Click **Continue with AI**.
3. Choose **Use local model (Ollama) — recommended**.
4. Enter the Ollama URL + model, then confirm the test succeeds.
5. Check that the handoff is copied to clipboard.
6. Confirm a file exists at `.threads/exports/context-handoff-<timestamp>.md`.

## Steps (already configured)
1. Click **Continue with AI**.
2. Confirm it copies a handoff to clipboard without opening panels.

## Expected
- If AI is not configured, a clear setup choice is shown.
- AI setup stores keys in SecretStorage (OpenAI) and does not write them to disk.
- Generated handoff is metadata-only by default (no code).
- Home directory paths are redacted.
- Failure to connect shows an error and does not block core snapshot functionality.
- If Ollama is slow to respond, increase `threads.llm.requestTimeoutMs` and `threads.llm.maxRetries`.
