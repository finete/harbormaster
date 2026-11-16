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
  /\bENETUNREACH\b/,
  /\bEHOSTUNREACH\b/,
  /\bENETDOWN\b/,
  /\bUND_ERR_CONNECT_TIMEOUT\b/,
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

// Transient: GitHub was reached (or the network is up) but this one request
// did not complete: our own child-process timeout (`run()`'s "timed out
// after Nms", a stalled connection), a 5xx from GitHub's edge, or GitHub's
// own GraphQL execution timeout. The next refresh tick is the retry, so one
// occurrence is not worth a warning; a persistent one still is. Never
// matches auth / not-found / validation / rate-limit failures, which no
// retry fixes.
const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /\btimed out after \d+ ?ms\b/i,
  /\bHTTP 50[0234]\b/,
  /\b50[234] (Bad Gateway|Service Unavailable|Gateway Time-?out)\b/i,
  /couldn't respond to your request in time/i,
  /something went wrong while executing your query/i,
];

/**
 * True when `message` looks like a one-off failure of a single request
 * (timeout, GitHub 5xx) that the next refresh tick is likely to clear,
 * rather than a failure a retry cannot fix (auth, not found, validation).
 * Disjoint from {@link isConnectivityError} in intent; callers check that
 * one first.
 */
export function isTransientError(message: string): boolean {
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(message));
}
