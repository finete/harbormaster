// Pure classifier tests: a dead network must read as connectivity, a real
// gh/API error (auth, not found, rate limit) must not — refresh() depends
// on this split to keep offline from ever becoming a wall of warnings.
import { describe, expect, it } from "vitest";
import { isConnectivityError } from "../src/engines/connectivity.js";

describe("isConnectivityError", () => {
  it.each([
    "error connecting to api.github.com check your internet",
    "GraphQL: error connecting to api.github.com",
    "getaddrinfo ENOTFOUND api.github.com",
    "connect ECONNREFUSED 140.82.112.6:443",
    "read ECONNRESET",
    "connect ETIMEDOUT 140.82.112.6:443",
    "getaddrinfo EAI_AGAIN api.github.com",
    "network is unreachable",
    "TLS handshake timeout",
    "Could not resolve host: api.github.com",
    "socket hang up",
  ])("classifies %s as a connectivity failure", (message) => {
    expect(isConnectivityError(message)).toBe(true);
  });

  it.each([
    "HTTP 401: Bad credentials (https://api.github.com/graphql)",
    "gh: To use GitHub CLI in a codespace, export GH_TOKEN",
    "GraphQL: Could not resolve to a Repository with the name 'x/y'.",
    "HTTP 403: API rate limit exceeded",
    "pull request #4 not found",
    "fatal: not a git repository",
    "gh auth login required",
  ])("does not classify %s as a connectivity failure", (message) => {
    expect(isConnectivityError(message)).toBe(false);
  });
});
