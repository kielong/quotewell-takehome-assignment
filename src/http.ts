// Shared HTTP layer: a single fetch wrapper with a per-attempt timeout and
// transport-level error classification.
//
// Design choice: non-2xx responses are NOT thrown. They are returned as a
// `response` outcome carrying status/headers/body so callers (notably the AMS
// client in Phase 5) can classify 201 / 200 / 429 / 503 / 422 / 400 themselves
// and read headers like `Retry-After`. Only genuine transport failures
// (timeout, external abort, network error) surface as the non-`response` kinds.

import { BASE_URL } from "./config.js";

export interface HttpResponse {
  kind: "response";
  status: number;
  ok: boolean;
  headers: Headers;
  bodyText: string;
}

// Transport failures, distinguished so retry logic can treat them correctly:
// - "timeout": our per-attempt AbortSignal.timeout fired (escape the stub hang)
// - "aborted": an external signal aborted (e.g. wall-clock budget exhausted)
// - "network": fetch/body-read failed for any other reason (connection refused…)
export interface HttpTransportError {
  kind: "timeout" | "aborted" | "network";
  error: Error;
}

export type HttpOutcome = HttpResponse | HttpTransportError;

export interface HttpRequestOptions {
  method?: string;
  path: string;
  // Serialized as JSON when provided (Content-Type set automatically).
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs: number;
  // Optional external signal (combined with the per-attempt timeout).
  signal?: AbortSignal;
}

export async function httpRequest(opts: HttpRequestOptions): Promise<HttpOutcome> {
  const { method = "GET", path, body, headers = {}, timeoutMs, signal } = opts;

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  const requestHeaders: Record<string, string> = { ...headers };
  let serializedBody: string | undefined;
  if (body !== undefined) {
    serializedBody = JSON.stringify(body);
    requestHeaders["Content-Type"] ??= "application/json";
  }

  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: requestHeaders,
      body: serializedBody,
      signal: combinedSignal,
    });
    // Read the body under the same signal so a mid-read hang is also aborted.
    const bodyText = await response.text();
    return {
      kind: "response",
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      bodyText,
    };
  } catch (err) {
    return classifyTransportError(err, signal, timeoutSignal);
  }
}

// Classify a transport failure into timeout / aborted / network.
//
// We decide by inspecting WHICH signal aborted rather than by the thrown error's
// name. Error-name sniffing ("TimeoutError" vs "AbortError") is brittle: some
// Node/undici versions don't propagate the AbortSignal.timeout reason and surface
// a generic AbortError, which would misclassify a per-attempt timeout (retryable)
// as an external abort (treated by callers as budget-exhausted → stop). Checking
// the signals removes that dependency; the error name is only a last-resort
// fallback.
function classifyTransportError(
  err: unknown,
  externalSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): HttpTransportError {
  const error = err instanceof Error ? err : new Error(String(err));
  // External signal wins if it fired (e.g. wall-clock budget exhausted), even if
  // the per-attempt timeout also fired in the same tick.
  if (externalSignal?.aborted) return { kind: "aborted", error };
  if (timeoutSignal.aborted) return { kind: "timeout", error };
  // Fallback for environments/cases where the signal state isn't conclusive.
  if (error.name === "TimeoutError") return { kind: "timeout", error };
  if (error.name === "AbortError") return { kind: "aborted", error };
  return { kind: "network", error };
}
