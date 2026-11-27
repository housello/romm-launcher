// Saves of native PC games, synced with WebDAV the way RetroArch's DOSBox Pure keeps its
// saves: whatever changed in the game's folder since it was downloaded goes into one zip.
// No save folder has to be known.
//
// - Baseline: before a native game's first launch, every file in its folder is noted
//   (size and modification time) in native-saves\<game id>.json in the data folder.
// - After playing: new or changed files, plus a list of deleted ones, go into
//   <WebDAV folder>/Native/<platform>/<game> [<id>].zip, uploaded when it differs from
//   what this PC last uploaded. Logs, temp files, crash dumps and caches are left out.
// - Before playing: a zip on WebDAV that changed since this PC last saw it is applied
//   over the game folder. If this PC also has changes not yet uploaded, the newer side
//   wins and the other is kept in save-backups\native\, so nothing is lost.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import { backupsDir, webdavClient } from "./folderSync";
import type { InstalledGame } from "./library";
import { dataDir } from "./paths";
import { readZipFiles, writeZip, type ZipFile } from "./zip";

/** Not saves: logs, temporary files, crash dumps and caches. */
const SKIP = [
  /\.(log|tmp|temp|dmp|mdmp|part|bak)$/i,
  /(^|\/)(thumbs\.db|desktop\.ini)$/i,
  /(^|\/)(logs?|crash(es|dumps|reports)?|cache|caches|shadercache|shader_cache|temp|tmp)(\/|$)/i,
];
const DELETED_LIST = "romm-launcher-deleted.json";
/** A diff bigger than this is not uploaded (something other than saves changed). */
const MAX_DIFF_BYTES = 512 * 1024 * 1024;

interface FileMark {
  size: number;
  mtime: number;
}

interface NativeRecord {
  baseline: Record<string, FileMark>;
  createdAt: number;
  /** Signature of the changes this PC last uploaded or applied. */
  synced?: string;
  /** The WebDAV zip's etag when this PC last uploaded or applied it. */
  remoteEtag?: string;
  lastUpload?: number;
}

const recordFile = (romId: number) => join(dataDir(), "native-saves", `${romId}.json`);
const readRecord = (romId: number): NativeRecord | null => {
  try {
    return JSON.parse(readFileSync(recordFile(romId), "utf8")) as NativeRecord;
  } catch {
    return null;
  }
};
async function writeRecord(romId: number, record: NativeRecord): Promise<void> {
  await mkdir(dirname(recordFile(romId)), { recursive: true });
  await writeFile(recordFile(romId), JSON.stringify(record));
}

/** Every file under `dir` ("/"-separated relative paths), saves-wise interesting ones only. */
function scan(dir: string): Map<string, FileMark> {
  const out = new Map<string, FileMark>();
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      const rel = relative(dir, full).split(sep).join("/");
      if (SKIP.some((re) => re.test(rel))) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const info = statSync(full);
        out.set(rel, { size: info.size, mtime: Math.floor(info.mtimeMs) });
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** What changed since the baseline. */
function changes(game: InstalledGame, record: NativeRecord) {
  const now = scan(game.dir);
  const changed = [...now].filter(([rel, mark]) => {
    const was = record.baseline[rel];
    return !was || was.size !== mark.size || was.mtime !== mark.mtime;
  });
  const deleted = Object.keys(record.baseline).filter((rel) => !now.has(rel));
  const signature = createHash("sha1").update(JSON.stringify([changed, deleted])).digest("hex");
  const newest = Math.max(0, ...changed.map(([, m]) => m.mtime));
  return { changed, deleted, signature, newest };
}

const safe = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "game";
const remotePath = (base: string, game: InstalledGame) => ({
  folder: [base, "Native", safe(game.platformSlug)].filter(Boolean).join("/"),
  file: `${safe(game.name)} [${game.romId}].zip`,
});

/** Note the folder as downloaded, if not done yet (before the first launch). */
export async function ensureBaseline(game: InstalledGame): Promise<void> {
  if (readRecord(game.romId)) return;
  await writeRecord(game.romId, { baseline: Object.fromEntries(scan(game.dir)), createdAt: Date.now() });
}

/** Forget the baseline (the game's local copy was deleted). */
export async function forgetBaseline(romId: number): Promise<void> {
  await rm(recordFile(romId), { force: true });
}

function zipOfChanges(game: InstalledGame, c: ReturnType<typeof changes>): Buffer {
  const files: ZipFile[] = c.changed.map(([rel, mark]) => ({ name: rel, contents: readFileSync(join(game.dir, rel)), modifiedAt: mark.mtime }));
  files.push({ name: DELETED_LIST, contents: Buffer.from(JSON.stringify(c.deleted)), modifiedAt: Date.now() });
  return writeZip(files);
}

async function keepBackup(game: InstalledGame, data: Buffer, label: string): Promise<string> {
  const dir = join(backupsDir(), "native", safe(game.platformSlug));
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${safe(game.name)} [${game.romId}] ${label} ${new Date().toISOString().replace(/[:.]/g, "-")}.zip`);
  await writeFile(file, data);
  return file;
}

/** Put a diff zip's files into the game folder and remove the files it lists as deleted. */
async function apply(game: InstalledGame, data: Buffer): Promise<void> {
  const entries = readZipFiles(data, { maxEntries: 100_000, maxTotalBytes: 4 * 1024 * 1024 * 1024 });
  for (const entry of entries) {
    if (entry.name === DELETED_LIST) continue;
    const target = join(game.dir, ...entry.name.split("/"));
    if (!target.startsWith(game.dir + sep)) continue; // never outside the game folder
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.contents);
  }
  const list = entries.find((e) => e.name === DELETED_LIST);
  for (const rel of list ? (JSON.parse(list.contents.toString("utf8")) as string[]) : []) {
    const target = join(game.dir, ...String(rel).split("/"));
    if (target.startsWith(game.dir + sep)) await rm(target, { force: true });
  }
}

async function remoteState(game: InstalledGame) {
  const { dav, base } = webdavClient();
  const where = remotePath(base, game);
  const listing = await dav.walk(where.folder);
  return { dav, where, remote: listing.get(where.file) ?? null };
}

/**
 * Before playing: bring this PC up to date with WebDAV. Returns a sentence for the
 * user, or null when nothing happened.
 */
export async function nativeBeforePlay(game: InstalledGame): Promise<string | null> {
  await ensureBaseline(game);
  const record = readRecord(game.romId)!;
  const { dav, where, remote } = await remoteState(game);
  if (!remote || remote.etag === record.remoteEtag) return null;
  const local = changes(game, record);
  // Changes on this PC that were neither uploaded nor came from WebDAV.
  const localUnsynced = (local.changed.length > 0 || local.deleted.length > 0) && local.signature !== record.synced;
  const data = await dav.get(`${where.folder}/${where.file}`);
  if (localUnsynced && local.newest > remote.mtime) {
    // This PC's saves are newer: keep them (they upload after this play); keep WebDAV's copy too.
    await keepBackup(game, data, "from WebDAV");
    await writeRecord(game.romId, { ...record, remoteEtag: remote.etag });
    return "Saves on this PC are newer than on WebDAV and were kept; the WebDAV copy is in the save backups.";
  }
  if (localUnsynced) await keepBackup(game, zipOfChanges(game, local), "this PC");
  await apply(game, data);
  await writeRecord(game.romId, { ...record, remoteEtag: remote.etag, synced: changes(game, record).signature });
  return localUnsynced
    ? "Newer saves from WebDAV applied; this PC's older ones are in the save backups."
    : "Saves from WebDAV applied.";
}

/** After playing: upload what changed, if it differs from what was last synced. */
export async function nativeAfterPlay(game: InstalledGame): Promise<string | null> {
  const record = readRecord(game.romId);
  if (!record) return null;
  const local = changes(game, record);
  if (local.signature === record.synced) return null;
  if (!local.changed.length && !local.deleted.length && !record.synced) return null;
  const bytes = local.changed.reduce((sum, [, m]) => sum + m.size, 0);
  if (bytes > MAX_DIFF_BYTES) {
    return `Saves not uploaded: ${Math.round(bytes / 1048576)} MB changed in the game folder, more than saves would.`;
  }
  const { dav, where } = await remoteState(game);
  await dav.put(`${where.folder}/${where.file}`, zipOfChanges(game, local));
  const after = (await dav.walk(where.folder)).get(where.file);
  await writeRecord(game.romId, { ...record, synced: local.signature, remoteEtag: after?.etag ?? record.remoteEtag, lastUpload: Date.now() });
  return `Saves uploaded to WebDAV (${local.changed.length} changed file${local.changed.length === 1 ? "" : "s"}).`;
}

/** For the details panel: whether native saves are tracked, and when they last went up. */
export function nativeSaveInfo(romId: number): { tracked: boolean; lastUpload: number | null } {
  const record = readRecord(romId);
  return { tracked: !!record, lastUpload: record?.lastUpload ?? null };
}
