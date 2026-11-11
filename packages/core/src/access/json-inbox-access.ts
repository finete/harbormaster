// Resource Access: persisted inbox items, `<stateDir>/inbox/items.json`,
// under a file lock (the app writes rule items; any client may resolve).

import type { InboxAccess, InboxItem } from "../contracts/inbox.js";
import { readJson, writeJsonAtomic } from "../utilities/atomic-json.js";
import { withFileLock } from "../utilities/file-lock.js";

interface InboxFile {
  version: 1;
  items: InboxItem[];
}

export class JsonInboxAccess implements InboxAccess {
  constructor(
    private readonly file: string,
    private readonly lockFile: string,
  ) {}

  async list(): Promise<InboxItem[]> {
    return (await this.read()).items;
  }

  async add(item: InboxItem): Promise<void> {
    await withFileLock(this.lockFile, async () => {
      const store = await this.read();
      store.items.push(item);
      await writeJsonAtomic(this.file, store);
    });
  }

  async update(
    id: string,
    patch: (item: InboxItem) => InboxItem,
  ): Promise<InboxItem | undefined> {
    return withFileLock(this.lockFile, async () => {
      const store = await this.read();
      const index = store.items.findIndex((item) => item.id === id);
      const current = store.items[index];
      if (!current) return undefined;
      const next = patch(current);
      store.items[index] = next;
      await writeJsonAtomic(this.file, store);
      return next;
    });
  }

  private async read(): Promise<InboxFile> {
    const store = await readJson<InboxFile>(this.file, () => ({
      version: 1,
      items: [],
    }));
    return Array.isArray(store?.items) ? store : { version: 1, items: [] };
  }
}
