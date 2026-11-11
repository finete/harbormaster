// "New version available" check (release plan, "Build and distribution").
// The app is installed and upgraded only through the Homebrew cask, so the
// check never downloads anything: it reads the latest GitHub release tag,
// compares it with the running version, and the renderer shows the
// `brew upgrade` command in a dismissible banner.
//
// Pure helpers (`compareSemver`, `parseReleaseVersion`) are unit-tested;
// `createUpdateChecker` takes its fetch, clock and timers injected so the
// main process wires the real ones (core's `HttpVersionAccess`, 6h interval).

export const DEFAULT_UPDATE_URL =
  "https://api.github.com/repos/finete/harbormaster/releases/latest";
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const UPGRADE_COMMAND = "brew upgrade --cask harbormaster";

export interface UpdateInfo {
  /** The newer release's version, without a leading `v` (e.g. `1.2.0`). */
  version: string;
  /** The shell command that upgrades the installed app. */
  command: string;
}

interface ParsedSemver {
  core: [number, number, number];
  prerelease: string[];
}

const SEMVER =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseSemver(value: string): ParsedSemver | undefined {
  const match = SEMVER.exec(value.trim());
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

/** True when `value` is a semver version (an optional leading `v` is allowed). */
export function isSemver(value: string): boolean {
  return parseSemver(value) !== undefined;
}

function comparePrereleaseIds(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Math.sign(Number(a) - Number(b));
  if (aNum) return -1; // numeric identifiers sort below alphanumeric ones
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Semver precedence (semver.org §11): -1 when `a` < `b`, 1 when `a` > `b`,
 * 0 when equal. Build metadata is ignored; a prerelease sorts below its
 * release. Throws on a value that is not semver.
 */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left) throw new Error(`not a semver version: ${a}`);
  if (!right) throw new Error(`not a semver version: ${b}`);
  for (const i of [0, 1, 2] as const) {
    const diff = left.core[i] - right.core[i];
    if (diff !== 0) return Math.sign(diff);
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i++) {
    const l = left.prerelease[i];
    const r = right.prerelease[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const diff = comparePrereleaseIds(l, r);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The version a release endpoint advertises: the GitHub "latest release"
 * JSON (`tag_name`), or a plain-text body holding just the tag. Returns the
 * version without its leading `v`, or `undefined` when there is none.
 */
export function parseReleaseVersion(body: string): string | undefined {
  const text = body.trim();
  let candidate: unknown = text;
  if (text.startsWith("{")) {
    try {
      const json = JSON.parse(text) as { tag_name?: unknown; draft?: unknown };
      if (json.draft === true) return undefined;
      candidate = json.tag_name;
    } catch {
      return undefined;
    }
  }
  if (typeof candidate !== "string") return undefined;
  const tag = candidate.trim();
  if (!isSemver(tag)) return undefined;
  return tag.replace(/^v/, "");
}

/** The update to offer, or `undefined` when `latest` is not newer than `current`. */
export function newerVersion(
  current: string,
  latestBody: string,
): UpdateInfo | undefined {
  const latest = parseReleaseVersion(latestBody);
  if (!latest || !isSemver(current)) return undefined;
  if (compareSemver(latest, current) <= 0) return undefined;
  return { version: latest, command: UPGRADE_COMMAND };
}

export interface UpdateCheckerOptions {
  currentVersion: string;
  url: string;
  fetchText: (url: string) => Promise<string>;
  onUpdate: (update: UpdateInfo) => void;
  intervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export interface UpdateChecker {
  /** Runs one check now; resolves with the newest known update (if any). */
  check(): Promise<UpdateInfo | undefined>;
  /** Checks now and then every `intervalMs` (6h by default). */
  start(): void;
  stop(): void;
  /** The newest update seen so far, for a renderer that loads late. */
  latest(): UpdateInfo | undefined;
}

export function createUpdateChecker(
  options: UpdateCheckerOptions,
): UpdateChecker {
  const every = options.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
  const schedule =
    options.setInterval ??
    ((fn: () => void, ms: number) => {
      const handle = setInterval(fn, ms);
      handle.unref?.();
      return handle;
    });
  const cancel =
    options.clearInterval ??
    ((handle: unknown) =>
      clearInterval(handle as ReturnType<typeof setInterval>));
  let timer: unknown;
  let known: UpdateInfo | undefined;

  async function check(): Promise<UpdateInfo | undefined> {
    try {
      const body = await options.fetchText(options.url);
      const update = newerVersion(options.currentVersion, body);
      if (
        update &&
        (!known || compareSemver(update.version, known.version) > 0)
      ) {
        known = update;
        options.onUpdate(update);
      }
    } catch {
      // Offline, rate-limited, no release yet: try again next interval.
    }
    return known;
  }

  return {
    check,
    start() {
      if (timer !== undefined) return;
      void check();
      timer = schedule(() => void check(), every);
    },
    stop() {
      if (timer === undefined) return;
      cancel(timer);
      timer = undefined;
    },
    latest: () => known,
  };
}
