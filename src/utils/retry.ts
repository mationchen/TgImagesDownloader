/**
 * Compute exponential backoff with jitter for retryable operations.
 * Spec §28: 429 / 5xx -> exponential backoff. 404 -> no / at most 1 retry.
 *
 * delayMs(attempt, baseMs=500, capMs=15_000) -> milliseconds to wait
 *   attempt is 1-based (1 = before the first retry).
 */

export function delayMs(
  attempt: number,
  baseMs = 500,
  capMs = 15_000,
): number {
  if (attempt <= 0) return 0;
  const exp = Math.min(capMs, baseMs * Math.pow(2, attempt - 1));
  const jitter = Math.random() * exp * 0.25; // up to 25% extra
  return Math.floor(exp + jitter);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxRetries: number;
    isRetryable?: (err: unknown) => boolean;
    onRetry?: (attempt: number, err: unknown) => void;
    baseMs?: number;
    capMs?: number;
  },
): Promise<T> {
  const {
    maxRetries,
    isRetryable = () => true,
    onRetry,
    baseMs = 500,
    capMs = 15_000,
  } = opts;
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > maxRetries || !isRetryable(err)) {
        throw err;
      }
      onRetry?.(attempt, err);
      await sleep(delayMs(attempt, baseMs, capMs));
    }
  }
}

/**
 * Decide whether an HTTP status code is worth retrying.
 * 429 (rate limit) and 5xx -> retry. 4xx (except 408/429) -> no retry.
 */
export function isRetryableHttpStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}
