// Client for the extraction service: POST /api/v1/extract { email } -> output.
//
// Transport here is reliable and deterministic, so (unlike the AMS client) this
// throws on any failure rather than returning a classified outcome. The caller
// turns a thrown ExtractError into a per-email `failed` verdict.

import { EXTRACT_TIMEOUT_MS } from "./config.js";
import { httpRequest } from "./http.js";

export class ExtractError extends Error {
  override readonly name = "ExtractError";
}

// Sends raw email text to the extraction service and returns the model's raw
// `output` string (which may be prose/markdown-wrapped JSON, or a refusal).
export async function extract(
  email: string,
  timeoutMs: number = EXTRACT_TIMEOUT_MS,
): Promise<string> {
  const outcome = await httpRequest({
    method: "POST",
    path: "/api/v1/extract",
    body: { email },
    timeoutMs,
  });

  if (outcome.kind !== "response") {
    throw new ExtractError(
      `extract transport failure (${outcome.kind}): ${outcome.error.message}`,
    );
  }
  if (!outcome.ok) {
    throw new ExtractError(
      `extract returned HTTP ${outcome.status}: ${outcome.bodyText.slice(0, 200)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.bodyText);
  } catch {
    throw new ExtractError(
      `extract returned non-JSON body: ${outcome.bodyText.slice(0, 200)}`,
    );
  }

  const output = (parsed as { output?: unknown }).output;
  if (typeof output !== "string") {
    throw new ExtractError('extract response missing string "output" field');
  }
  return output;
}
