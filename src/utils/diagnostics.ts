export function diagnosticErrorKind(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).toLocaleLowerCase();
  if (error instanceof DOMException && error.name === "AbortError") return "aborted";
  if (/timed?\s*out|timeout/.test(message)) return "timeout";
  if (/network connection|network request|failed to fetch|could not reach/.test(message)) return "network";
  if (/\b401\b|\b403\b|api.?key|permission|unauthori[sz]ed/.test(message)) return "authentication";
  if (/\b429\b|quota|rate.?limit/.test(message)) return "rate_limit";
  if (/\b5\d\d\b|unavailable|overloaded/.test(message)) return "service_unavailable";
  return error instanceof Error && error.name ? error.name : "unknown_error";
}
