// Outbound HTTPS for the main process through Chromium's network stack
// (Electron's `net.fetch`) instead of Node's fetch. Node trusts only its
// bundled Mozilla CA list plus NODE_EXTRA_CA_CERTS, which an app opened from
// the Dock or Finder never inherits; behind a TLS-inspecting proxy
// (Netskope, Zscaler, ...) every request then fails with
// SELF_SIGNED_CERT_IN_CHAIN. Chromium verifies against the macOS keychain,
// where MDM installs the proxy's root CA, and honors the system proxy
// settings, exactly like the user's browser.
//
// Handed to core as `HttpVersionAccess`'s fetch (version endpoints) and to
// the update check. Failures reject with `net::ERR_*` messages, which the
// connectivity classifier and the TLS hint in core recognize.
import { app, net } from "electron";

export const systemFetch: typeof fetch = async (input, init) => {
  // net.fetch throws before `ready`; a fetch that early just waits for it.
  await app.whenReady();
  const target = input instanceof URL ? input.href : input;
  return (await net.fetch(target, init)) as Response;
};
