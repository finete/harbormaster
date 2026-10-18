// Pure classifier mirroring @harbormaster/core's `engines/connectivity.ts`
// (not imported directly: the renderer has no Node access, and the core
// package's barrel re-exports Node-dependent access/ code — see
// preload/api.ts's "only plain data shapes cross the bridge" boundary
// comment, and lib/repository-label.ts for the same pattern). This is the
// toast-side belt-and-suspenders guard: the real fix is core's refresh()
// never putting a connectivity-shaped message in `warnings` at all, so in
// practice `pushToast` should never even see one of these strings.
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

export function isConnectivityError(message: string): boolean {
  return CONNECTIVITY_PATTERNS.some((pattern) => pattern.test(message));
}
