/**
 * Deadlines for provider HTTP calls.
 *
 * Every request Token Watch makes is on a background timer feeding a status
 * bar. A hung socket without a deadline pins the in-flight promise forever,
 * which also pins the single-flight guard: the provider stops refreshing for
 * the rest of the session with no error anywhere. Each request gets its own
 * AbortController, chained to any caller-supplied signal.
 *
 * This module MUST NOT import `vscode`.
 */

/** Default per-request deadline. Usage endpoints answer in well under a second. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export class RequestTimeoutError extends Error {
  constructor(public readonly url: string, public readonly timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = "RequestTimeoutError";
  }
}

export function isRequestTimeoutError(error: unknown): error is RequestTimeoutError {
  return error instanceof RequestTimeoutError;
}

export interface TimedFetchOptions extends RequestInit {
  timeoutMs?: number;
}

/**
 * `fetch` with a deadline that covers the whole exchange, body included.
 *
 * A deadline that ends when the headers arrive is barely a deadline: a server
 * can send `200 OK` and then never finish the body, and the caller's
 * `response.json()` hangs forever — pinning the single-flight guard exactly as
 * a dead socket would. The body is therefore read inside the timeout, and the
 * returned Response carries the buffered bytes.
 *
 * `init.signal` is honoured too: whichever fires first aborts the request.
 */
export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: TimedFetchOptions = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal, ...rest } = init;
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  const onCallerAbort = () => controller.abort();
  signal?.addEventListener("abort", onCallerAbort, { once: true });

  try {
    const response = await fetchImpl(url, { ...rest, signal: controller.signal });
    return await bufferWithinDeadline(response);
  } catch (error) {
    if (timedOut) {
      throw new RequestTimeoutError(url, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

/**
 * Drain the body while the deadline still applies and hand back an equivalent
 * Response the caller can read as many times as it likes.
 */
async function bufferWithinDeadline(response: Response): Promise<Response> {
  // The Response constructor rejects a body for these, and rejects a status
  // below 200 outright; there is nothing to drain in either case.
  if (!response.body || NULL_BODY_STATUSES.has(response.status) || response.status < 200) {
    return response;
  }
  const body = await response.arrayBuffer();
  const buffered = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  // `Response` does not carry `url` through its constructor, and callers use it
  // in error messages.
  Object.defineProperty(buffered, "url", { value: response.url, configurable: true });
  return buffered;
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
