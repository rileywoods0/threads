type RetryFetchOptions = {
  timeoutMs: number;
  retries: number;
  retryDelayMs?: number;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(baseMs: number, attempt: number): number {
  return baseMs * Math.max(1, attempt);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableError(err: unknown): boolean {
  const message = String(err ?? '');
  return message.includes('Headers Timeout') || message.includes('fetch failed') || message.includes('ECONNRESET');
}

export function formatFetchError(err: unknown, label: string): string {
  const message = String(err ?? '');
  if (message.includes('AbortError') || message.includes('Headers Timeout')) {
    return `${label} timed out. If using Ollama, make sure the server is running and the model is warm.`;
  }
  if (message.includes('ECONNREFUSED')) {
    return `${label} was refused. Check the server URL and that the service is running.`;
  }
  return `${label} failed: ${message}`;
}

export async function fetchWithRetry(url: string, init: RequestInit, options: RetryFetchOptions): Promise<Response> {
  const retries = Math.max(0, options.retries);
  const retryDelayMs = Math.max(100, options.retryDelayMs ?? 500);

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok && isRetryableStatus(response.status) && attempt < retries) {
        await delay(backoffMs(retryDelayMs, attempt + 1));
        continue;
      }
      return response;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt >= retries || !isRetryableError(err)) {
        throw err;
      }
      await delay(backoffMs(retryDelayMs, attempt + 1));
    }
  }

  throw lastError ?? new Error('fetch failed');
}
