// Save sync to a folder on this PC (another drive, a NAS share, or a folder that the
// OneDrive / Google Drive / Dropbox desktop app syncs): the same layout and rules as
// WebDAV, with plain file copies. A file's "etag" is its size and modification time.

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import type { DavFile, SaveStore } from "./webdav";

/** Copies that cloud desktop apps leave when both sides changed; never saves of ours. */
const CONFLICT_COPY = /conflicted copy|-conflict-/i;

export class LocalStore implements SaveStore {
  readonly label = "the local folder";
  private readonly root: string;

  constructor(folder: string) {
    if (!folder.trim()) throw new Error("Choose the local sync folder in Settings → Storage.");
    if (!isAbsolute(folder)) throw new Error("The local sync folder must be a full path, e.g. D:\\Saves.");
    this.root = resolve(folder);
  }

  /** A "/"-separated path under the root, never outside it. */
  private full(path: string): string {
    const full = join(this.root, ...path.split("/").filter(Boolean));
    if (full !== this.root && !full.startsWith(this.root + sep)) throw new Error(`Not inside the sync folder: ${path}`);
    return full;
  }

  /** A missing drive or share is an error, not an empty folder. */
  private ensureReachable(): void {
    const top = parse(this.root).root;
    if (top && !existsSync(top)) throw new Error(`${top} is not available (drive unplugged or share offline?).`);
  }

  async walk(path: string): Promise<Map<string, DavFile>> {
    this.ensureReachable();
    const files = new Map<string, DavFile>();
    const visit = async (dir: string, prefix: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await visit(full, rel);
        else if (entry.isFile() && !entry.name.endsWith(".romm-tmp") && !CONFLICT_COPY.test(entry.name)) {
          const info = await stat(full);
          const mtime = Math.round(info.mtimeMs);
          files.set(rel, { rel, size: info.size, mtime, etag: `local-${info.size}-${mtime}` });
        }
      }
    };
    await visit(this.full(path), "");
    return files;
  }

  async get(path: string): Promise<Buffer> {
    return readFile(this.full(path));
  }

  /** Written next to the target, then renamed over it, so a half-written file never shows. */
  async put(path: string, data: Buffer): Promise<void> {
    const full = this.full(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full + ".romm-tmp", data);
    await rename(full + ".romm-tmp", full);
  }

  async check(path: string): Promise<void> {
    this.ensureReachable();
    const full = this.full(path);
    await mkdir(full, { recursive: true });
    const probe = join(full, ".romm-launcher-check");
    await writeFile(probe, "ok");
    await rm(probe, { force: true });
  }
}
