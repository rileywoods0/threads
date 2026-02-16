# Changelog

## Unreleased
- Redesigned Threads sidebar into structured sections (Resume, Continue, History, Settings & Tools).
- Added **Continue with AI** for one-step agent handoffs.
- Added **Run Smoke Test** for one-click validation.
- Renamed AI setup to **Enhance with AI (Optional)** with privacy-first settings.
- Added AI request reliability controls: `threads.llm.requestTimeoutMs` and `threads.llm.maxRetries`.
- Added timeout/retry handling for Ollama/OpenAI provider requests.
- Improved local storage scoping so snapshot history is filtered by workspace root path.
- Added heuristic "open loops" signals to improve next-session recovery context.
