// Engine: pure classifier that tells "the machine has no network path to
// GitHub right now" apart from a real gh/API failure (bad auth, missing
// repo, rate limit, ...). No I/O — refresh() in the manager uses this to
// decide whether a per-task failure becomes a per-task warning (today's
// behavior) or rolls up into a single connectivity marker (the offline
// banner). Patterns cover gh's own network-failure phrasing plus the
// Node/libcurl error codes a dead network or a TLS stall surfaces as.
const CONNECTIVITY_PATTERNS: readonly RegExp[] = [
  /error connecting to/i,
  /check your internet/i,
  /\bENOTFOUND\b/,
  /\bECONNREFUSED\b/,
  /\bECONNRESET\b/,
  /\bETIMEDOUT\b/,
  /\bEAI_AGAIN\b/,
  /getaddrinfo/i,
  /network is unreachable/i,
  /network unreachable/i,
  /tls handshake timeout/i,
  /handshake timeout/i,
  /could not resolve host/i,
  /socket hang up/i,
];

/**
 * True when `message` looks like a connectivity/environmental failure
 * (offline, DNS down, connection refused/reset, handshake timeout) rather
 * than a real API-level error (auth, not found, rate limit, validation).
 */
export function isConnectivityError(message: string): boolean {
  return CONNECTIVITY_PATTERNS.some((pattern) => pattern.test(message));
}
