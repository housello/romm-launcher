// Two-way sync of emulator save folders with a WebDAV folder:
//   <WebDAV folder>/<emulator>/<save folder name>/<files as they are>
//
// For each file, both sides are compared with the last sync (folder-sync.json):
// changed on one side only → copied to the other; changed on both → a conflict,
// left alone until the user picks a side. Nothing is ever deleted: a file gone
// from one side is copied back from the other. Before a local file is replaced,
// it is copied to <data folder>\save-backups.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";
import { getWebdavPassword, loadConfig, type EmulatorDef, type SyncFolder } from "./config";
import { PRESETS, type Preset } from "./emulators";
import { dataDir, resolvePath } from "./paths";
import { WebDav } from "./webdav";

/** A file both sides changed since the last sync. */
export interface Conflict {
  key: string;
  folder: string;
  rel: string;
  local: { size: number; mtime: number };
  remote: { size: number; mtime: number };
}

export type Resolution = "local" | "remote" | "skip";

export interface FolderSyncReport {
  uploaded: string[];
  downloaded: string[];
  conflicts: Conflict[];
}

interface FileRecord {
  hash: string;
  size: number;
  mtime: number;
  etag: string;
}

const MAX_FILE_BYTES = 256 * 1024 * 1024;

// ------------------------------------------------------------------ folders

/** The catalog entry an emulator came from, by install record or executable name. */
export function presetOf(emulator: EmulatorDef): Preset | undefined {
  if (emulator.managed) return PRESETS.find((p) => p.key === emulator.managed!.key);
  const exe = (emulator.path.split(/[\\/]/).pop() ?? "").toLowerCase();
  return PRESETS.find((p) => p.exe && new RegExp(`^${p.exe}$`, "i").test(exe));
}

function expand(path: string, emulatorDir: string): string {
  const withEnv = path.replace(/%([^%]+)%/g, (m, name: string) => process.env[name] ?? m);
  return isAbsolute(withEnv) ? withEnv : join(emulatorDir, withEnv);
}

/** The folders synced for an emulator: its own list, else the catalog's defaults. */
export function syncFoldersOf(emulator: EmulatorDef): SyncFolder[] {
  if (emulator.syncFolders) return emulator.syncFolders;
  const emulatorDir = dirname(resolvePath(emulator.path));
  return (presetOf(emulator)?.saveFolders ?? []).map((f) => ({
    name: f.name,
    // The first location that exists, so a portable and an installed copy both work.
    path: f.paths.find((p) => existsSync(expand(p, emulatorDir))) ?? f.paths[0]!,
    enabled: f.on,
  }));
}

/** An emulator's folder on WebDAV: its catalog key, else its name made safe. */
function remoteRoot(emulator: EmulatorDef): string {
  const key = presetOf(emulator)?.key;
  return key && key !== "custom" ? key : emulator.name.replace(/[^\w .-]/g, "_").trim() || emulator.id;
}

/** Where a synced folder is on this PC. */
export function localPathOf(emulator: EmulatorDef, folder: SyncFolder): string {
  return expand(folder.path, dirname(resolvePath(emulator.path)));
}

// ------------------------------------------------------------------ records

const recordsFile = () => join(dataDir(), "folder-sync.json");
let records: Record<string, FileRecord> | null = null;

function loadRecords(): Record<string, FileRecord> {
  if (records) return records;
  try {
    records = existsSync(recordsFile()) ? JSON.parse(readFileSync(recordsFile(), "utf8")) : {};
  } catch {
    records = {};
  }
  return records!;
}

function saveRecords(): void {
  writeFileSync(recordsFile() + ".tmp", JSON.stringify(loadRecords()));
  renameSync(recordsFile() + ".tmp", recordsFile());
}

// ------------------------------------------------------------------ local side

interface LocalFile {
  full: string;
  size: number;
  mtime: number;
}

async function walkLocal(root: string): Promise<Map<string, LocalFile>> {
  const files = new Map<string, LocalFile>();
  const visit = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(full, rel);
      else if (entry.isFile()) {
        const info = await stat(full);
        if (info.size <= MAX_FILE_BYTES) files.set(rel, { full, size: info.size, mtime: Math.round(info.mtimeMs) });
      }
    }
  };
  await visit(root, "");
  return files;
}

const sha1 = (data: Buffer) => createHash("sha1").update(data).digest("hex");

async function backup(folderKey: string, rel: string, full: string): Promise<void> {
  if (!existsSync(full)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(dataDir(), "save-backups", ...folderKey.split("/"), ...rel.split("/")) + `.${stamp}`;
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(full, dest);
}

// ------------------------------------------------------------------ sync

export function webdavClient(): { dav: WebDav; base: string } {
  const config = loadConfig();
  if (!config.webdav.url) throw new Error("Set the WebDAV address in Settings → Storage.");
  const dav = new WebDav(config.webdav.url, config.webdav.username, getWebdavPassword(config));
  return { dav, base: config.webdav.folder.replace(/^\/+|\/+$/g, "") };
}

/**
 * Sync every enabled folder of an emulator. Conflicts are reported, not touched;
 * `resolve` is asked about them and their answers applied.
 */
export async function syncEmulatorFolders(
  emulator: EmulatorDef,
  resolve: (conflicts: Conflict[]) => Promise<Record<string, Resolution>>,
): Promise<FolderSyncReport> {
  const { dav, base } = webdavClient();
  const report: FolderSyncReport = { uploaded: [], downloaded: [], conflicts: [] };
  const recs = loadRecords();
  // What a conflict needs to be settled later.
  const pending = new Map<string, { remotePath: string; local: string; folderKey: string; rel: string }>();

  const upload = async (remotePath: string, key: string, full: string, data: Buffer) => {
    await dav.put(remotePath, data);
    const info = await stat(full);
    recs[key] = { hash: sha1(data), size: info.size, mtime: Math.round(info.mtimeMs), etag: "" };
  };
  const download = async (remotePath: string, key: string, folderKey: string, rel: string, full: string, remoteMtime: number) => {
    const data = await dav.get(remotePath);
    await backup(folderKey, rel, full);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
    if (remoteMtime) await utimes(full, new Date(remoteMtime), new Date(remoteMtime)).catch(() => undefined);
    const info = await stat(full);
    recs[key] = { hash: sha1(data), size: info.size, mtime: Math.round(info.mtimeMs), etag: "" };
  };

  for (const folder of syncFoldersOf(emulator).filter((f) => f.enabled)) {
    const local = localPathOf(emulator, folder);
    const folderKey = `${remoteRoot(emulator)}/${folder.name}`;
    const remoteDir = [base, folderKey].filter(Boolean).join("/");
    const [localFiles, remoteFiles] = await Promise.all([walkLocal(local), dav.walk(remoteDir)]);
    const touched: string[] = [];

    for (const rel of new Set([...localFiles.keys(), ...remoteFiles.keys()])) {
      const key = `${folderKey}|${rel}`;
      const rec = recs[key];
      const l = localFiles.get(rel);
      const r = remoteFiles.get(rel);
      const remotePath = `${remoteDir}/${rel}`;
      const full = l?.full ?? join(local, ...rel.split("/"));
      const label = `${folderKey}/${rel}`;

      if (l && !r) {
        await upload(remotePath, key, full, await readFile(full));
        report.uploaded.push(label);
        touched.push(key);
        continue;
      }
      if (!l && r) {
        await download(remotePath, key, folderKey, rel, full, r.mtime);
        report.downloaded.push(label);
        touched.push(key);
        continue;
      }
      if (!l || !r) continue;

      // Unchanged size and time since the last sync: the content is too.
      const sameAsRecord = rec && l.size === rec.size && l.mtime === rec.mtime;
      const data = sameAsRecord ? null : await readFile(full);
      const localHash = sameAsRecord ? rec!.hash : sha1(data!);
      const localChanged = !rec || localHash !== rec.hash;
      const remoteChanged = !rec || !rec.etag || r.etag !== rec.etag;

      if (!rec) {
        // Both sides have it and no history: equal content is simply in sync.
        const remote = await dav.get(remotePath);
        if (sha1(remote) === localHash) {
          recs[key] = { hash: localHash, size: l.size, mtime: l.mtime, etag: r.etag };
          continue;
        }
      } else if (!localChanged && !remoteChanged) {
        continue;
      } else if (localChanged && !remoteChanged) {
        await upload(remotePath, key, full, data ?? (await readFile(full)));
        report.uploaded.push(label);
        touched.push(key);
        continue;
      } else if (!localChanged && remoteChanged) {
        await download(remotePath, key, folderKey, rel, full, r.mtime);
        report.downloaded.push(label);
        touched.push(key);
        continue;
      }
      report.conflicts.push({ key, folder: folderKey, rel, local: { size: l.size, mtime: l.mtime }, remote: { size: r.size, mtime: r.mtime } });
      pending.set(key, { remotePath, local: full, folderKey, rel });
    }

    // Uploads and downloads change the server's etags: read them back once.
    if (touched.length) {
      const after = await dav.walk(remoteDir);
      for (const key of touched) {
        const rel = key.slice(folderKey.length + 1);
        if (recs[key]) recs[key]!.etag = after.get(rel)?.etag ?? "";
      }
    }
    saveRecords();
  }

  if (report.conflicts.length) {
    const answers = await resolve(report.conflicts);
    for (const conflict of report.conflicts) {
      const choice = answers[conflict.key] ?? "skip";
      const p = pending.get(conflict.key)!;
      if (choice === "local") {
        // The WebDAV copy it replaces is kept as a local backup.
        const remote = await dav.get(p.remotePath);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const dest = join(dataDir(), "save-backups", ...p.folderKey.split("/"), ...p.rel.split("/")) + `.webdav.${stamp}`;
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, remote);
        await upload(p.remotePath, conflict.key, p.local, await readFile(p.local));
        report.uploaded.push(`${p.folderKey}/${p.rel}`);
      } else if (choice === "remote") {
        await download(p.remotePath, conflict.key, p.folderKey, p.rel, p.local, conflict.remote.mtime);
        report.downloaded.push(`${p.folderKey}/${p.rel}`);
      } else {
        continue;
      }
      const after = await dav.walk(p.remotePath.slice(0, p.remotePath.length - p.rel.length - 1));
      if (recs[conflict.key]) recs[conflict.key]!.etag = after.get(p.rel)?.etag ?? "";
    }
    saveRecords();
  }
  return report;
}

/** One line for a toast. */
export function describeFolderSync(report: FolderSyncReport): string | null {
  const files = (n: number) => `${n} save file${n === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (report.downloaded.length) parts.push(`${files(report.downloaded.length)} from WebDAV`);
  if (report.uploaded.length) parts.push(`${files(report.uploaded.length)} to WebDAV`);
  return parts.length ? `Synced ${parts.join(", ")}` : null;
}

export const backupsDir = () => join(dataDir(), "save-backups") + sep;
