// Engine: Plannotator review support per harness (docs/plannotator.md
// decision 5 and "Minimum versions"). Pure: raw probe outputs in (from
// `ReviewSupportProbeAccess`), the per-piece and per-harness states out.
// A harness's state is its worst piece; a harness with no pieces (no review
// capability) is `unsupported`.

import type {
  ReviewSupportHarness,
  ReviewSupportPiece,
} from "../contracts/model.js";

export type ReviewPieceId = ReviewSupportPiece["id"];

/** Minimum versions (docs/plannotator.md "Minimum versions"). */
export const REVIEW_MINIMUMS: Record<ReviewPieceId, string> = {
  binary: "0.28.0",
  "pi-extension": "0.28.0",
  "claude-plugin": "0.28.52",
  "claude-code": "2.1.287",
};

const LABELS: Record<ReviewPieceId, string> = {
  binary: "Plannotator",
  "pi-extension": "Plannotator Pi extension",
  "claude-plugin": "Plannotator Claude Code plugin",
  "claude-code": "Claude Code",
};

const BINARY_INSTALL = "curl -fsSL https://plannotator.ai/install.sh | bash";

/** The exact shell command per piece: install when missing, upgrade otherwise. */
const FIXES: Record<ReviewPieceId, { install: string; upgrade: string }> = {
  binary: { install: BINARY_INSTALL, upgrade: BINARY_INSTALL },
  "pi-extension": {
    install: "pi install npm:@plannotator/pi-extension",
    upgrade: "pi update npm:@plannotator/pi-extension",
  },
  "claude-plugin": {
    install:
      "claude plugin marketplace add backnotprop/plannotator && claude plugin install plannotator@plannotator",
    upgrade:
      "claude plugin marketplace update plannotator && claude plugin update plannotator@plannotator",
  },
  // Not in the design record's fix list: Claude Code's own installer/updater.
  "claude-code": {
    install: "curl -fsSL https://claude.ai/install.sh | bash",
    upgrade: "claude update",
  },
};

/** The Claude plugin id Plannotator ships as. */
export const PLANNOTATOR_CLAUDE_PLUGIN_ID = "plannotator@plannotator";

/** The first `x.y.z` in `text` (prerelease/build suffixes dropped), if any. */
export function parseSemver(text: string | undefined): string | undefined {
  return text?.match(/(\d+)\.(\d+)\.(\d+)/)?.[0];
}

/** Numeric `x.y.z` comparison: negative when `a < b`, 0 when equal, positive when `a > b`. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index++) {
    const diff = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The installed `@plannotator/pi-extension` version from its `package.json` text. */
export function piExtensionVersion(
  manifest: string | undefined,
): string | undefined {
  if (!manifest) return undefined;
  try {
    const parsed = JSON.parse(manifest) as { version?: unknown };
    return typeof parsed.version === "string"
      ? parseSemver(parsed.version)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The installed `plannotator@plannotator` version from `claude plugin list`:
 * the `--json` array (an enabled entry preferred), else the text listing
 * (`❯ plannotator@plannotator` followed by `Version: x.y.z`).
 */
export function claudePluginVersion(
  output: string | undefined,
): string | undefined {
  if (!output?.trim()) return undefined;
  try {
    const parsed = JSON.parse(output) as unknown;
    if (Array.isArray(parsed)) {
      const entries = parsed.filter(
        (
          entry,
        ): entry is { id: string; version?: unknown; enabled?: unknown } =>
          Boolean(entry) &&
          typeof entry === "object" &&
          (entry as { id?: unknown }).id === PLANNOTATOR_CLAUDE_PLUGIN_ID,
      );
      const entry =
        entries.find((candidate) => candidate.enabled !== false) ?? entries[0];
      return typeof entry?.version === "string"
        ? parseSemver(entry.version)
        : undefined;
    }
  } catch {
    // Not JSON: the text listing.
  }
  const lines = output.split("\n");
  const at = lines.findIndex((line) =>
    new RegExp(`(^|\\s)${PLANNOTATOR_CLAUDE_PLUGIN_ID}(\\s|$)`).test(line),
  );
  if (at === -1) return undefined;
  for (const line of lines.slice(at + 1)) {
    if (/@/.test(line) && !/version/i.test(line)) break;
    const match = line.match(/version:\s*(\S+)/i);
    if (match) return parseSemver(match[1]);
  }
  return undefined;
}

/** One piece's state from its installed version. */
export function reviewPiece(
  id: ReviewPieceId,
  installed: string | undefined,
): ReviewSupportPiece {
  const minimum = REVIEW_MINIMUMS[id];
  const state: ReviewSupportPiece["state"] = !installed
    ? "missing"
    : compareSemver(installed, minimum) < 0
      ? "outdated"
      : "ready";
  return {
    id,
    label: LABELS[id],
    ...(installed ? { installed } : {}),
    minimum,
    state,
    fix: state === "missing" ? FIXES[id].install : FIXES[id].upgrade,
  };
}

const SEVERITY: Record<ReviewSupportPiece["state"], number> = {
  ready: 0,
  outdated: 1,
  missing: 2,
};

/** A harness's status: the worst of its pieces; `unsupported` without any. */
export function reviewHarness(
  harness: string,
  pieces: ReviewSupportPiece[],
): ReviewSupportHarness {
  if (pieces.length === 0) {
    return { harness, state: "unsupported", pieces };
  }
  const worst = pieces.reduce((acc, piece) =>
    SEVERITY[piece.state] > SEVERITY[acc.state] ? piece : acc,
  );
  return { harness, state: worst.state, pieces };
}

/** The installed versions the probes found (semver or absent). */
export interface ReviewVersions {
  binary?: string;
  "pi-extension"?: string;
  "claude-plugin"?: string;
  "claude-code"?: string;
}

/**
 * Which pieces a harness needs for a Plannotator review: Pi runs the Pi
 * extension (its own server), Claude Code the binary + plugin + a recent
 * enough Claude Code; any other harness with a review command runs the
 * binary. A harness that cannot start a review needs nothing (`unsupported`).
 */
export function reviewPiecesFor(harness: {
  id: string;
  review?: unknown;
}): ReviewPieceId[] {
  if (!harness.review) return [];
  switch (harness.id) {
    case "pi":
      return ["pi-extension"];
    case "claude-code":
      return ["binary", "claude-plugin", "claude-code"];
    default:
      return ["binary"];
  }
}

/** One harness's review support from the probed versions. */
export function reviewSupportFor(
  harness: { id: string; review?: unknown },
  versions: ReviewVersions,
): ReviewSupportHarness {
  return reviewHarness(
    harness.id,
    reviewPiecesFor(harness).map((id) => reviewPiece(id, versions[id])),
  );
}

/** Hosts an agent-opened URL may show in-app (docs/plannotator.md decision 6). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The normalized URL when it is `http(s)` on a loopback host, else `undefined`. */
export function loopbackUrl(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return undefined;
  if (url.username || url.password) return undefined;
  return url.href;
}
