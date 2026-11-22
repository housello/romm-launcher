// Save and save-state sync with RomM.
//
// Uses the plain /api/saves and /api/states endpoints (list, upload, content),
// the same ones RomM's own web player uses, so it works without device
// registration. Rules, in order of importance:
//
//   1. Never lose a save. A local file is copied to .backups/ before it is
//      overwritten by a download.
//   2. Pull before the emulator starts, push after it exits.
//   3. A file is "changed" when its hash differs from the one recorded at the
//      last sync; the server copy is "changed" when its id/updated_at differs.
//      When both changed, the newer one wins and the other is kept as a backup.

import { app } from "electron";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { apiFetch, apiGet } from "./api";
import { loadConfig, type EmulatorDef, type PlatformMapping } from "./config";
import { expandPlaceholders, placeholderValues, saveModeOf } from "./emulators";
import { baseDir, dataDir, resolvePath, toStored } from "./paths";

const MAX_SAVE_BYTES = 512 * 1024 * 1024;

export type SaveKind = "save" | "state";

interface ServerRow {
  id: number;
  file_name: string;
  updated_at: string;
  emulator?: string | null;
  file_size_bytes?: number;
  download_path?: string;
}

/** Where one kind of file lives locally and which server rows map onto it. */
export interface SaveTarget {
  kind: SaveKind;
  dir: string;
  /** Local files that belong to this target. */
  matches: (fileName: string) => boolean;
  /** Local file name a server row should be written to, or null if it does not belong here. */
  localName: (serverName: string) => string | null;
}

export interface SyncContext {
  romId: number;
  /** Name sent as RomM's `emulator` field (the libretro core for RetroArch). */
  emulatorKey: string;
  targets: SaveTarget[];
}

export interface SyncReport {
  downloaded: string[];
  uploaded: string[];
  conflicts: string[];
  errors: string[];
}

const emptyReport = (): SyncReport => ({ downloaded: [], uploaded: [], conflicts: [], errors: [] });

// ------------------------------------------------------------- sync records

interface Record_ {
  /** Hash of the local file right after the last sync. */
  hash: string;
  serverId: number;
  serverUpdatedAt: string;
}

const recordsFile = () => join(dataDir(), "save-sync.json");
let records: Record<string, Record_> | null = null;

function loadRecords(): Record<string, Record_> {
  if (records) return records;
  try {
    records = existsSync(recordsFile()) ? JSON.parse(readFileSync(recordsFile(), "utf8")) : {};
  } catch {
    records = {};
  }
  return records!;
}

function saveRecords(): void {
  mkdirSync(dirname(recordsFile()), { recursive: true });
  writeFileSync(recordsFile() + ".tmp", JSON.stringify(loadRecords(), null, 1));
  renameSync(recordsFile() + ".tmp", recordsFile());
}

const recordKey = (romId: number, target: SaveTarget, name: string) => `${romId}|${target.kind}|${toStored(join(target.dir, name)).toLowerCase()}`;

// ------------------------------------------------------------------ targets

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Folder for synced saves of one game, outside the (deletable) game folder. */
export function gameSaveDir(platformSlug: string, romId: number): string {
  return join(resolvePath(loadConfig().saveDir), platformSlug.replace(/[^\w.-]/g, "_"), String(romId));
}

function patternTarget(kind: SaveKind, pattern: string, vars: Record<string, string>): SaveTarget {
  const resolved = resolve(baseDir(), expandPlaceholders(pattern, vars));
  const dir = dirname(resolved);
  const glob = basename(resolved);
  const re = new RegExp("^" + glob.split("*").map(escapeRe).join(".*") + "$", "i");
  return {
    kind,
    dir,
    matches: (name) => re.test(name),
    // A server file belongs here when its name fits the pattern. When the pattern
    // has no wildcard, any file with the same extension is renamed onto it, so a
    // save uploaded from a differently named copy of the game still lands.
    localName: (server) => {
      if (re.test(server)) return server;
      if (!glob.includes("*") && extname(server).toLowerCase() === extname(glob).toLowerCase()) return glob;
      return null;
    },
  };
}

export interface LaunchSaveSetup {
  ctx: SyncContext | null;
  /** Extra arguments to put in front of the emulator's own (RetroArch --appendconfig). */
  extraArgs: string[];
}

/** Work out where this launch's saves live; for RetroArch also pin its folders. */
export async function prepareSaves(
  emulator: EmulatorDef,
  mapping: PlatformMapping,
  game: { romId: number; platformSlug: string; dir: string; launchFile: string },
): Promise<LaunchSaveSetup> {
  const mode = saveModeOf(emulator);
  // Sync off: leave the emulator on its own native save folders.
  if (mode === "off" || !loadConfig().syncSaves) return { ctx: null, extraArgs: [] };
  const romPath = join(game.dir, game.launchFile);
  const romName = basename(romPath, extname(romPath));
  const saveRoot = gameSaveDir(game.platformSlug, game.romId);

  if (mode === "retroarch") {
    const saves = join(saveRoot, "saves");
    const states = join(saveRoot, "states");
    await mkdir(saves, { recursive: true });
    await mkdir(states, { recursive: true });
    const cfg = join(saveRoot, "retroarch-append.cfg");
    await writeFile(cfg, [
      "# Written by RomM Launcher: keeps this game's saves in a folder it syncs with RomM.",
      `savefile_directory = "${saves}"`,
      `savestate_directory = "${states}"`,
      'sort_savefiles_enable = "false"',
      'sort_savefiles_by_content_enable = "false"',
      'savefiles_in_content_dir = "false"',
      'sort_savestates_enable = "false"',
      'sort_savestates_by_content_enable = "false"',
      'savestates_in_content_dir = "false"',
      "",
    ].join("\n"), "utf8");
    const stateRe = /\.state(\d+|\.auto)?$/i;
    const targets: SaveTarget[] = [
      {
        kind: "save",
        dir: saves,
        matches: (n) => n.toLowerCase() === `${romName}.srm`.toLowerCase(),
        localName: (s) => (extname(s).toLowerCase() === ".srm" ? `${romName}.srm` : null),
      },
      {
        kind: "state",
        dir: states,
        matches: (n) => n.toLowerCase().startsWith(romName.toLowerCase() + ".state") && stateRe.test(n),
        localName: (s) => {
          const m = s.match(stateRe);
          return m ? `${romName}${m[0]}` : null;
        },
      },
    ];
    return { ctx: { romId: game.romId, emulatorKey: mapping.core || "retroarch", targets }, extraArgs: ["--appendconfig", cfg] };
  }

  const vars = placeholderValues(emulator, { rom: romPath, slug: game.platformSlug, romId: game.romId, saveDir: saveRoot });
  const targets: SaveTarget[] = [];
  if (emulator.savePattern?.trim()) targets.push(patternTarget("save", emulator.savePattern.trim(), vars));
  if (emulator.statePattern?.trim()) targets.push(patternTarget("state", emulator.statePattern.trim(), vars));
  if (!targets.length) return { ctx: null, extraArgs: [] };
  const key = emulator.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "emulator";
  return { ctx: { romId: game.romId, emulatorKey: key, targets }, extraArgs: [] };
}

// ------------------------------------------------------------------ server

const endpoint = (kind: SaveKind) => (kind === "save" ? "saves" : "states");

async function listServer(kind: SaveKind, romId: number): Promise<ServerRow[]> {
  const body = await apiGet<unknown>(`/api/${endpoint(kind)}?rom_id=${romId}`);
  const rows = Array.isArray(body) ? body : ((body as { items?: unknown[] })?.items ?? []);
  return (rows as ServerRow[]).filter((r) => typeof r?.id === "number" && typeof r.file_name === "string");
}

async function downloadRow(kind: SaveKind, row: ServerRow, dest: string): Promise<void> {
  let response = await apiFetch(`/api/${endpoint(kind)}/${row.id}/content`, { headers: { Accept: "*/*" } });
  if (response.status === 404 && row.download_path) response = await apiFetch(row.download_path, { headers: { Accept: "*/*" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if ((response.headers.get("content-type") ?? "").includes("text/html")) throw new Error("server returned a web page");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_SAVE_BYTES) throw new Error("file too large");
  if (row.file_size_bytes && bytes.length !== row.file_size_bytes) throw new Error("incomplete download");
  await mkdir(dirname(dest), { recursive: true });
  const part = join(dirname(dest), `.${basename(dest)}.part`);
  await writeFile(part, bytes);
  await rename(part, dest);
  const when = new Date(row.updated_at);
  if (!Number.isNaN(when.getTime())) await utimes(dest, when, when).catch(() => undefined);
}

async function uploadFile(kind: SaveKind, romId: number, emulatorKey: string, path: string): Promise<ServerRow | null> {
  const bytes = await readFile(path);
  const boundary = "----romm" + createHash("md5").update(String(Math.random())).digest("hex");
  const field = kind === "save" ? "saveFile" : "stateFile";
  const name = basename(path).replace(/"/g, "_");
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const params = new URLSearchParams({ rom_id: String(romId), emulator: emulatorKey });
  const response = await apiFetch(`/api/${endpoint(kind)}?${params}`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}${response.status === 409 ? " (conflict)" : ""}`);
  const row = (await response.json().catch(() => null)) as ServerRow | ServerRow[] | null;
  const one = Array.isArray(row) ? row[0] : row;
  return one && typeof one.id === "number" ? one : null;
}

// --------------------------------------------------------------------- hash

async function hashOf(path: string): Promise<string | null> {
  try {
    return createHash("sha1").update(await readFile(path)).digest("hex");
  } catch {
    return null;
  }
}

async function backup(target: SaveTarget, name: string, romSaveRoot: string): Promise<void> {
  const src = join(target.dir, name);
  if (!existsSync(src)) return;
  const dir = join(romSaveRoot, ".backups");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await copyFile(src, join(dir, `${name}.${stamp}`));
  // Keep the 10 newest backups per file.
  const old = (await readdir(dir)).filter((f) => f.startsWith(name + ".")).sort().reverse().slice(10);
  for (const f of old) await rm(join(dir, f), { force: true });
}

// --------------------------------------------------------------------- pull

const newest = (a: ServerRow, b: ServerRow) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0);

/** Bring newer server saves down. Never throws: a sync problem must not block a launch. */
export async function pullSaves(ctx: SyncContext, backupRoot: string): Promise<SyncReport> {
  const report = emptyReport();
  const recs = loadRecords();
  for (const target of ctx.targets) {
    let rows: ServerRow[];
    try {
      rows = await listServer(target.kind, ctx.romId);
    } catch (error) {
      report.errors.push(`list ${target.kind}s: ${(error as Error).message}`);
      continue;
    }
    // Only rows written by this emulator (or by nobody in particular).
    rows = rows.filter((r) => !r.emulator || r.emulator.toLowerCase() === ctx.emulatorKey.toLowerCase());
    // Newest server row per local file name.
    const byLocal = new Map<string, ServerRow>();
    for (const row of [...rows].sort(newest)) {
      const local = target.localName(row.file_name);
      if (local && !byLocal.has(local)) byLocal.set(local, row);
    }
    for (const [name, row] of byLocal) {
      const path = join(target.dir, name);
      const key = recordKey(ctx.romId, target, name);
      const rec = recs[key];
      const serverChanged = !rec || rec.serverId !== row.id || rec.serverUpdatedAt !== row.updated_at;
      if (!serverChanged) continue;
      const localHash = await hashOf(path);
      let take: boolean;
      if (!localHash) take = true;
      else if (rec && localHash === rec.hash) take = true; // only the server moved on
      else {
        // Both sides have something new (or there is no history): newer wins.
        const localTime = (await stat(path)).mtimeMs;
        take = (Date.parse(row.updated_at) || 0) > localTime;
        if (rec) report.conflicts.push(`${name}: kept the ${take ? "server" : "local"} copy (newer)`);
      }
      if (!take) continue;
      try {
        if (localHash) await backup(target, name, backupRoot);
        await downloadRow(target.kind, row, path);
        recs[key] = { hash: (await hashOf(path)) ?? "", serverId: row.id, serverUpdatedAt: row.updated_at };
        report.downloaded.push(name);
      } catch (error) {
        report.errors.push(`download ${name}: ${(error as Error).message}`);
      }
    }
  }
  saveRecords();
  return report;
}

// --------------------------------------------------------------------- push

/** Send local saves that changed since the last sync. Never throws. */
export async function pushSaves(ctx: SyncContext): Promise<SyncReport> {
  const report = emptyReport();
  const recs = loadRecords();
  for (const target of ctx.targets) {
    let names: string[] = [];
    try {
      names = (await readdir(target.dir)).filter((n) => !n.startsWith(".") && target.matches(n));
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(target.dir, name);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile() || info.size === 0 || info.size > MAX_SAVE_BYTES) continue;
      const hash = await hashOf(path);
      const key = recordKey(ctx.romId, target, name);
      if (!hash || recs[key]?.hash === hash) continue;
      try {
        const row = await uploadFile(target.kind, ctx.romId, ctx.emulatorKey, path);
        recs[key] = { hash, serverId: row?.id ?? 0, serverUpdatedAt: row?.updated_at ?? "" };
        report.uploaded.push(name);
      } catch (error) {
        report.errors.push(`upload ${name}: ${(error as Error).message}`);
      }
    }
  }
  saveRecords();
  return report;
}

export function describe(report: SyncReport, phase: "pull" | "push"): string | null {
  const parts: string[] = [];
  const n = (list: string[]) => `${list.length} file${list.length === 1 ? "" : "s"}`;
  if (phase === "pull" && report.downloaded.length) parts.push(`Downloaded ${n(report.downloaded)} from RomM`);
  if (phase === "push" && report.uploaded.length) parts.push(`Uploaded ${n(report.uploaded)} to RomM`);
  if (report.conflicts.length) parts.push(`Conflict: ${report.conflicts.join("; ")} (other copy in .backups)`);
  if (report.errors.length) parts.push(`Save sync problem: ${report.errors.join("; ")}`);
  return parts.length ? parts.join(". ") : null;
}
