// Utility: a stat-keyed parse cache for one JSON state file. The board and
// refresh paths read tasks.json / workspace-bindings.json many times per
// tick (listBoard every few seconds, getTask/patchTask per refreshed task),
// and each read used to re-parse and re-validate the whole file. This keeps
// the last validated parse and reuses it while the file is unchanged.
//
// Change detection: `stat(path, { bigint: true })` → inode + size +
// nanosecond mtime + nanosecond ctime. Why no content hash:
// - Every writer of these files (this process and any other core instance,
//   e.g. the Pi extension) goes through `writeJsonAtomic`, which writes a
//   temp file and renames it over the target. Each write therefore installs
//   a *new inode* and the inode alone already changes on every write; on
//   APFS file IDs are never reused, so ino alone is decisive there.
// - On filesystems that may recycle inode numbers (ext4), a stale hit would
//   additionally need an identical size AND identical nanosecond mtime and
//   ctime; nanosecond timestamps (APFS, ext4) make the "same-ms external
//   write" race moot. Only a coarse-timestamp FS (FAT/HFS+, 1s/2s) recycling
//   the inode with the same size within the same tick could fool it, which
//   does not apply to `~/.harbormaster`.
// - A hash would require reading the file on every call, which is most of
//   what a cache hit is meant to skip.
// The stat is taken *before* the read, so a write racing the read can only
// cache newer content under an older key (a harmless miss next time), never
// older content under a newer key.
//
// Callers get the cached value by reference and must treat it as read-only;
// owners clone what they hand out or mutate (see `JsonTaskStateAccess`).
// Writes made through this process call `invalidate()`.

import { readFile, stat } from "node:fs/promises";

export class JsonFileCache<T> {
  private entry: { key: string; value: T } | undefined;

  constructor(
    private readonly path: string,
    private readonly fallback: () => T,
    /** Throws on invalid content; only validated values are cached. */
    private readonly validate: (value: unknown) => void,
  ) {}

  /** The current validated content. Shared and cached: do not mutate. */
  async read(): Promise<T> {
    let key: string;
    try {
      const info = await stat(this.path, { bigint: true });
      key = `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.entry = undefined;
      return this.fallbackValue();
    }
    if (this.entry?.key === key) return this.entry.value;
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      // Removed between stat and read.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.entry = undefined;
      return this.fallbackValue();
    }
    const parsed: unknown = JSON.parse(raw);
    this.validate(parsed);
    const value = parsed as T;
    this.entry = { key, value };
    return value;
  }

  private fallbackValue(): T {
    const value = this.fallback();
    this.validate(value);
    return value;
  }

  /** Forget the cached parse (call after writing the file). */
  invalidate(): void {
    this.entry = undefined;
  }
}
