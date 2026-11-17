// Utility: recognizes an HTTPS chain this process does not trust, from
// Node (`SELF_SIGNED_…`, `UNABLE_TO_GET_ISSUER_…`) or Chromium
// (`net::ERR_CERT_AUTHORITY_INVALID`): almost always a TLS-inspecting proxy
// (Netskope, Zscaler, …) re-signing traffic with a corporate root CA.
// Expired or wrong-host certificates are a different problem and do not
// match. Used by the HTTP access (error text) and the doctor (verdict).

const UNTRUSTED_CERTIFICATE =
  /\b(?:SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_GET_ISSUER_CERT(?:_LOCALLY)?|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_UNTRUSTED)\b|net::ERR_CERT_AUTHORITY_INVALID/;

export function isUntrustedCertificateError(message: string): boolean {
  return UNTRUSTED_CERTIFICATE.test(message);
}

export const TLS_TRUST_HINT =
  "the server's TLS certificate is not trusted (a TLS-inspecting proxy?): the app trusts root CAs in the macOS keychain; Node tools need NODE_EXTRA_CA_CERTS pointing at the proxy's CA bundle";
