// Pure classifier tests: a dead network must read as connectivity, a real
// gh/API error (auth, not found, rate limit) must not — refresh() depends
// on this split to keep offline from ever becoming a wall of warnings.
import { describe, expect, it } from "vitest";
import {
  isConnectivityError,
  isTransientError,
} from "../src/engines/connectivity.js";

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
    "connect ENETUNREACH 10.0.0.1:443",
    "connect EHOSTUNREACH 10.0.0.1:443",
    "fetch failed (UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error)",
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

describe("isTransientError", () => {
  it.each([
    "gh api graphql -f query=…(4123 chars) failed: timed out after 20000ms",
    "HTTP 502: Bad Gateway (https://api.github.com/graphql)",
    "HTTP 504: Gateway Timeout (https://api.github.com/graphql)",
    "GraphQL: Something went wrong while executing your query. This may be the result of a timeout",
    "We couldn't respond to your request in time. Sorry about that.",
  ])("classifies %s as transient", (message) => {
    expect(isTransientError(message)).toBe(true);
  });

  it.each([
    "HTTP 401: Bad credentials (https://api.github.com/graphql)",
    "HTTP 403: API rate limit exceeded",
    "HTTP 404: Not Found",
    "GraphQL: Could not resolve to a Repository with the name 'x/y'.",
    "Unexpected GitHub GraphQL payload: no repository",
  ])("does not classify %s as transient", (message) => {
    expect(isTransientError(message)).toBe(false);
  });
});
