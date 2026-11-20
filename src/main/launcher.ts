// Download a ROM from RomM (if not already on disk) and start it in the
// emulator mapped to its platform.

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { apiFetch, apiGet } from "./api";
import { loadConfig, type EmulatorDef, type PlatformMapping } from "./config";
import { buildArgs } from "./emulators";
import { getInstalled, listInstalled, metaOf, putInstalled, removeInstalled, type InstalledGame } from "./library";
import { checkServer, isOffline, noteFailure } from "./connection";
import { recordSession } from "./playSessions";
import { findChdFolder, isArcade, setNameOf } from "./chd";
import { resolvePath } from "./paths";
import { readZipFiles } from "./zip";
import { describe, gameSaveDir, prepareSaves, pullSaves, pushSaves, type SyncContext } from "./saves";

export type LaunchEvent =
  | { romId: number; type: "progress"; label: string; received: number; total: number }
  | { romId: number; type: "running"; emulator: string }
  | { romId: number; type: "exited"; code: number | null; seconds: number }
  | { romId: number; type: "error"; message: string }
  | { romId: number; type: "installed" }
  | { romId: number; type: "idle" }
  | { romId: number; type: "choose-file"; files: string[]; suggested: string }
  | { romId: number; type: "notice"; message: string; level: "ok" | "error" | "" };

type Emit = (event: LaunchEvent) => void;

interface RomFile {
  id: number;
  file_name: string;
  full_path?: string;
  file_size_bytes?: number;
}

interface RomDetail {
  id: number;
  name: string | null;
  fs_name: string;
  fs_name_no_ext?: string;
  fs_path?: string;
  fs_size_bytes?: number;
  platform_slug: string;
  platform_fs_slug?: string;
  platform_display_name?: string;
  platform_name?: string;
  path_cover_small?: string | null;
  path_cover_large?: string | null;
  url_cover?: string | null;
  files?: RomFile[];
}

export class LaunchError extends Error {
  constructor(message: string, public code: "no-emulator" | "failed" | "cancelled" | "offline" = "failed") {
    super(message);
  }
}

// ------------------------------------------------------- launch-file choice

/** Extensions that are never what you launch: data, docs, media, libraries. */
const NOT_LAUNCHABLE = new Set([".txt", ".nfo", ".diz", ".doc", ".pdf", ".htm", ".html", ".jpg", ".jpeg", ".png", ".gif", ".bmp",
  ".ico", ".sav", ".srm", ".xml", ".sfv", ".md5", ".sha1", ".dll", ".ini", ".cfg", ".ogg", ".wav", ".mp3", ".flac", ".sub", ".sbi",
  ".dat", ".part", ".log", ".json", ".url"]);
/** Track files that belong to a cue/ccd/gdi sheet rather than being launched themselves. */
const TRACK_EXT = new Set([".bin", ".img", ".raw"]);

/** Files that could reasonably be handed to the emulator. */
export function launchCandidates(files: string[]): string[] {
  const hasSheet = files.some((f) => [".cue", ".ccd", ".gdi", ".m3u"].includes(extname(f).toLowerCase()));
  return files.filter((f) => {
    const ext = extname(f).toLowerCase();
    if (NOT_LAUNCHABLE.has(ext)) return false;
    if (hasSheet && TRACK_EXT.has(ext)) return false;
    return true;
  });
}

/** Launches waiting for the user to pick a file, keyed by rom id. */
const pendingChoices = new Map<number, (rel: string | null) => void>();

/** Called by the renderer with the user's pick (null = cancelled). */
export function resolveFileChoice(romId: number, rel: string | null): void {
  pendingChoices.get(romId)?.(rel);
  pendingChoices.delete(romId);
}

function askForFile(romId: number, candidates: string[], suggested: string, emit: Emit): Promise<string | null> {
  pendingChoices.get(romId)?.(null);
  return new Promise((resolve) => {
    pendingChoices.set(romId, (rel) => resolve(rel !== null && candidates.includes(rel) ? rel : null));
    emit({ romId, type: "choose-file", files: candidates, suggested });
  });
}

const jobs = new Map<number, AbortController>();
const running = new Map<number, ChildProcess>();

export function isBusy(romId: number): boolean {
  return jobs.has(romId) || running.has(romId);
}

export function runningGames(): number[] {
  return [...running.keys()];
}

export function cancel(romId: number): void {
  jobs.get(romId)?.abort();
  const child = running.get(romId);
  if (child && !child.killed) child.kill();
}

/** Mapping + emulator for a platform, trying slug then fs_slug. */
export function resolveEmulator(slugs: string[]): { emulator: EmulatorDef; mapping: PlatformMapping } | null {
  const config = loadConfig();
  for (const slug of slugs) {
    const mapping = slug ? config.platforms[slug] : undefined;
    if (!mapping) continue;
    const emulator = config.emulators.find((e) => e.id === mapping.emulatorId);
    // Emulator paths may be relative to the launcher's folder (portable).
    if (emulator) return { emulator: { ...emulator, path: resolvePath(emulator.path) }, mapping };
  }
  return null;
}

// ---------------------------------------------------------------- download

const PRIORITY = [".m3u", ".cue", ".gdi", ".ccd", ".mds", ".cdi", ".chd", ".rvz", ".wbfs", ".iso", ".gcm", ".cso", ".pbp",
  ".wua", ".wux", ".wud", ".rpx", ".xci", ".nsp", ".3ds", ".cci", ".cia", ".nds", ".z64", ".n64", ".v64", ".sfc", ".smc",
  ".nes", ".gba", ".gbc", ".gb", ".md", ".gen", ".sms", ".gg", ".pce", ".exe", ".bat", ".conf", ".zip", ".7z"];
const DISC_FOR_PLAYLIST = [".cue", ".chd", ".gdi", ".ccd", ".cdi", ".iso", ".pbp"];
const IGNORE = [".txt", ".nfo", ".jpg", ".png", ".pdf", ".sav", ".srm", ".xml", ".dat", ".sfv", ".md5"];

/** Pick the file an emulator should be handed, writing an .m3u for multi-disc sets. */
export async function pickLaunchFile(dir: string, files: string[], romName: string): Promise<string> {
  if (files.length === 1) return files[0]!;
  const eboot = files.find((f) => basename(f).toUpperCase() === "EBOOT.BIN");
  if (eboot) return eboot;
  const byExt = (ext: string) => files.filter((f) => extname(f).toLowerCase() === ext).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const m3u = byExt(".m3u");
  if (m3u.length) return m3u[0]!;
  for (const ext of DISC_FOR_PLAYLIST) {
    const discs = byExt(ext);
    if (discs.length > 1) {
      const name = `${romName.replace(/[\\/:*?"<>|]/g, "_")}.m3u`;
      await writeFile(join(dir, name), discs.map((d) => d.split(sep).join("/")).join("\n") + "\n", "utf8");
      return name;
    }
  }
  for (const ext of PRIORITY) {
    const match = byExt(ext);
    if (match.length) return match[0]!;
  }
  const candidates = files.filter((f) => !IGNORE.includes(extname(f).toLowerCase()));
  return (candidates[0] ?? files[0])!;
}

function safeRelative(path: string): string {
  const cleaned = normalize(path.replace(/[\\/]+/g, sep)).replace(/^([\\/])+/, "");
  if (!cleaned || isAbsolute(cleaned) || cleaned.split(sep).includes("..")) throw new LaunchError(`Unsafe file path from server: ${path}`);
  return cleaned.split(sep).map((part) => part.replace(/[<>:"|?*]/g, "_")).join(sep);
}

/** Path of a ROM file relative to the ROM's own folder (for multi-file ROMs). */
function relativeName(rom: RomDetail, file: RomFile): string {
  const root = rom.fs_path && rom.fs_name ? `${rom.fs_path}/${rom.fs_name}/` : null;
  const full = (file.full_path ?? "").replace(/\\/g, "/");
  if (root && full.startsWith(root)) return safeRelative(full.slice(root.length));
  return safeRelative(file.file_name);
}

/**
 * Download one file to `dest`, through `dest`.part. An interrupted download keeps
 * its .part, and the next attempt asks only for the missing bytes (HTTP Range).
 * Returns the file's full size.
 */
async function downloadTo(path: string, dest: string, signal: AbortSignal, onProgress: (received: number, total: number) => void): Promise<number> {
  await mkdir(dirname(dest), { recursive: true });
  const part = dest + ".part";
  let offset = 0;
  try {
    offset = statSync(part).size;
  } catch {
    /* nothing to resume */
  }
  const headers: Record<string, string> = { Accept: "*/*" };
  if (offset) headers.Range = `bytes=${offset}-`;
  const response = await apiFetch(path, { signal, headers });
  if (offset && response.status === 416) {
    // The .part already holds the whole file.
    await rename(part, dest);
    onProgress(offset, offset);
    return offset;
  }
  if (!response.ok || !response.body) throw new LaunchError(`Download failed: HTTP ${response.status}`);
  if ((response.headers.get("content-type") ?? "").includes("text/html")) throw new LaunchError("Server returned a web page instead of the file (check credentials).");
  // A 206 must continue exactly where the .part ends; anything else starts over.
  const range = /^bytes (\d+)-\d+\/(\d+|\*)/.exec(response.headers.get("content-range") ?? "");
  const resuming = offset > 0 && response.status === 206 && Number(range?.[1]) === offset;
  if (!resuming) offset = 0;
  const length = Number(response.headers.get("content-length") ?? 0);
  const total = length ? offset + length : 0;
  let received = offset;
  let last = 0;
  if (resuming) console.info(`[download] resuming ${basename(dest)} at ${offset} bytes`);
  const source = Readable.fromWeb(response.body as never);
  source.on("data", (chunk: Buffer) => {
    received += chunk.length;
    const now = Date.now();
    if (now - last > 250) {
      last = now;
      onProgress(received, total);
    }
  });
  // Kept on failure or cancel, so the next attempt resumes it.
  await pipeline(source, createWriteStream(part, { flags: resuming ? "a" : "w" }), { signal });
  if (total && received !== total) throw new LaunchError(`Download of ${basename(dest)} ended early; press Play again to resume it.`);
  await rename(part, dest);
  onProgress(received, total || received);
  return received;
}

/** Folder a platform's games are downloaded to: the per-platform override, or <romDir>\<slug>. */
export function platformFolder(slugs: string[]): string {
  const config = loadConfig();
  for (const slug of slugs) {
    const folder = slug ? config.platforms[slug]?.folder?.trim() : "";
    if (folder) return resolvePath(folder);
  }
  return join(resolvePath(config.romDir), safeRelative(slugs.find(Boolean) ?? "unknown"));
}

/** True when the file is already there with the expected size (e.g. an existing library folder). */
function alreadyThere(path: string, size: number | undefined): boolean {
  try {
    const info = statSync(path);
    return info.isFile() && (!size || info.size === size);
  } catch {
    return false;
  }
}

/** Delete the files this launcher created, then any folders left empty, never above `root`. */
async function removeFiles(root: string, rels: string[]): Promise<void> {
  const dirs = new Set<string>();
  for (const rel of rels) {
    const path = join(root, rel);
    await rm(path, { force: true });
    for (let d = dirname(path); d.length > root.length && d.startsWith(root); d = dirname(d)) dirs.add(d);
  }
  // Deepest first, so a parent is only tried after its children.
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      if ((await readdir(d)).length === 0) await rm(d, { recursive: true, force: true });
    } catch {
      /* already gone or not empty */
    }
  }
}

async function extractZip(dir: string, zipRel: string, deleteZip: boolean): Promise<string[]> {
  const archive = await readFile(join(dir, zipRel));
  const entries = readZipFiles(archive, { maxEntries: 20000, maxTotalBytes: 3.5 * 1024 ** 3 });
  const outRoot = join(dir, basename(zipRel, extname(zipRel)));
  const out: string[] = [];
  for (const entry of entries) {
    const rel = safeRelative(entry.name);
    const target = join(outRoot, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.contents);
    out.push(relative(dir, target));
  }
  if (deleteZip) await rm(join(dir, zipRel), { force: true });
  return out;
}

/**
 * A MAME romset's disk images, when the server keeps them as a RomM game of their
 * own (roms/chd/sfiii/…): downloaded next to the romset as <set>/<disk>.chd, which
 * is where MAME looks. A clone uses its parent's folder (sfiiia → sfiii).
 * Never fails the launch: without the CHD, MAME itself reports the missing disk.
 */
async function fetchCompanions(
  romId: number,
  slugs: Array<string | undefined | null>,
  dir: string,
  launchFile: string,
  signal: AbortSignal,
  emit: Emit,
): Promise<{ companions: string[]; created: string[]; bytes: number }> {
  const none = { companions: [], created: [], bytes: 0 };
  if (!isArcade(slugs) || !setNameOf(basename(launchFile))) return none;
  emit({ romId, type: "progress", label: "Looking for CHD disks…", received: 0, total: 0 });
  let chd;
  try {
    chd = await findChdFolder(basename(launchFile));
  } catch (error) {
    emit({ romId, type: "notice", message: `Could not look for CHD disks: ${(error as Error).message}`, level: "error" });
    return none;
  }
  if (!chd) return none;
  const companions: string[] = [];
  const created: string[] = [];
  const total = chd.files.reduce((s, f) => s + f.sizeBytes, 0);
  let bytes = 0;
  for (const [i, file] of chd.files.entries()) {
    const rel = join(safeRelative(chd.folder), safeRelative(basename(file.fileName)));
    const dest = join(dir, rel);
    const label = `CHD ${chd.folder}/${basename(file.fileName)}${chd.files.length > 1 ? ` (${i + 1}/${chd.files.length})` : ""}`;
    if (alreadyThere(dest, file.sizeBytes)) {
      bytes += file.sizeBytes;
    } else {
      const base = bytes;
      bytes += await downloadTo(`/api/roms/${chd.romId}/content/${encodeURIComponent(file.fileName)}?file_ids=${file.id}`, dest, signal,
        (r, t) => emit({ romId, type: "progress", label, received: base + r, total: total || t }));
      created.push(rel);
    }
    companions.push(rel);
  }
  return { companions, created, bytes };
}

/**
 * Whether a multi-file ROM laid out flat in `dir` would overwrite a different file
 * another downloaded game uses (same name, other size), e.g. two games' disc1.bin.
 */
function clashesInFolder(dir: string, rom: RomDetail, files: NonNullable<RomDetail["files"]>): boolean {
  const used = new Set(
    listInstalled().flatMap((g) => [...g.files, ...(g.companions ?? [])].map((f) => join(g.dir, f).toLowerCase())),
  );
  return files.some((file) => {
    const dest = join(dir, relativeName(rom, file));
    return used.has(dest.toLowerCase()) && !alreadyThere(dest, file.file_size_bytes);
  });
}

export async function install(romId: number, emit: Emit, options: { extractZip?: boolean } = {}): Promise<InstalledGame> {
  const existing = getInstalled(romId);
  if (existing) return existing;
  if (jobs.has(romId)) throw new LaunchError("This game is already downloading.");
  const controller = new AbortController();
  jobs.set(romId, controller);
  try {
    const rom = await apiGet<RomDetail>(`/api/roms/${romId}`);
    const slug = rom.platform_slug || rom.platform_fs_slug || "unknown";
    const files = (rom.files ?? []).filter((f) => typeof f.id === "number" && f.file_name);
    // Layout: <platform folder>\rom.ext for a single file, <platform folder>\<rom folder>\... for
    // multi-file ROMs, mirroring the RomM library, unless the settings ask for them flat.
    const platformDir = platformFolder([rom.platform_slug, rom.platform_fs_slug ?? ""]);
    const ownFolder = files.length > 1 && (loadConfig().multiFileLayout !== "flat" || clashesInFolder(platformDir, rom, files));
    const dir = ownFolder ? join(platformDir, safeRelative(rom.fs_name)) : platformDir;
    await mkdir(dir, { recursive: true });

    const totalBytes = files.reduce((sum, f) => sum + (f.file_size_bytes ?? 0), 0) || rom.fs_size_bytes || 0;
    let done = 0;
    let written: string[] = [];
    /** Files created by this install; only these are deleted by "Delete local copy". */
    const created: string[] = [];

    const fetchOne = async (url: string, rel: string, size: number | undefined, label: string) => {
      const dest = join(dir, rel);
      if (alreadyThere(dest, size)) {
        done += size ?? 0;
        emit({ romId, type: "progress", label: `${label} (already on disk)`, received: done, total: totalBytes });
      } else {
        const base = done;
        done += await downloadTo(url, dest, controller.signal, (r, t) => emit({ romId, type: "progress", label, received: base + r, total: totalBytes || t }));
        created.push(rel);
      }
      written.push(rel);
    };

    if (files.length === 0) {
      await fetchOne(`/api/roms/${romId}/content/${encodeURIComponent(rom.fs_name)}`, safeRelative(rom.fs_name), rom.fs_size_bytes, rom.fs_name);
    } else if (files.length === 1) {
      const file = files[0]!;
      await fetchOne(`/api/roms/${romId}/content/${encodeURIComponent(file.file_name)}?file_ids=${file.id}`,
        safeRelative(basename(file.file_name)), file.file_size_bytes, file.file_name);
    } else {
      for (const [i, file] of files.entries()) {
        await fetchOne(`/api/roms/${romId}/content/${encodeURIComponent(file.file_name)}?file_ids=${file.id}`,
          relativeName(rom, file), file.file_size_bytes, `${file.file_name} (${i + 1}/${files.length})`);
      }
    }

    const romName = rom.fs_name_no_ext || basename(rom.fs_name, extname(rom.fs_name));
    let launchFile = await pickLaunchFile(dir, written, romName);
    if (options.extractZip && extname(launchFile).toLowerCase() === ".zip") {
      emit({ romId, type: "progress", label: "Extracting…", received: 0, total: 0 });
      // A zip that was already in the user's folder is left alone; only a downloaded one is replaced.
      const ownZip = created.includes(launchFile);
      const extracted = await extractZip(dir, launchFile, ownZip);
      if (ownZip) created.splice(created.indexOf(launchFile), 1);
      written = written.filter((f) => !(ownZip && f === launchFile)).concat(extracted);
      created.push(...extracted);
      launchFile = await pickLaunchFile(dir, extracted, romName);
    }
    if (!written.includes(launchFile)) {
      written.push(launchFile); // a generated .m3u
      created.push(launchFile);
    }

    const extra = await fetchCompanions(romId, [rom.platform_slug, rom.platform_fs_slug], dir, launchFile, controller.signal, emit);
    created.push(...extra.created);

    const game: InstalledGame = {
      romId,
      name: rom.name || romName,
      platformSlug: slug,
      platformName: rom.platform_display_name || rom.platform_name || slug,
      dir,
      files: written,
      created,
      companions: extra.companions,
      companionsChecked: true,
      launchFile,
      sizeBytes: (done || totalBytes) + extra.bytes,
      coverPath: rom.path_cover_small || rom.path_cover_large || null,
      coverUrl: rom.url_cover || null,
      meta: metaOf(rom),
      installedAt: Date.now(),
      lastPlayed: null,
    };
    putInstalled(game);
    emit({ romId, type: "installed" });
    return game;
  } catch (error) {
    if (controller.signal.aborted) throw new LaunchError("Download cancelled.");
    throw error;
  } finally {
    jobs.delete(romId);
  }
}

export async function uninstall(romId: number): Promise<void> {
  // Saves that live inside the game folder (custom patterns like {romDir}) would
  // be deleted with it: upload them first, and refuse if that fails.
  const current = getInstalled(romId);
  const resolved = current && resolveEmulator([current.platformSlug]);
  if (current && resolved && loadConfig().syncSaves) {
    const { ctx } = await prepareSaves(resolved.emulator, resolved.mapping, current);
    const inside = ctx && ctx.targets.some((t) => (t.dir + sep).toLowerCase().startsWith((current.dir + sep).toLowerCase()));
    if (ctx && inside) {
      const report = await pushSaves(ctx);
      if (report.errors.length) throw new LaunchError(`Saves could not be uploaded, nothing deleted: ${report.errors.join("; ")}`);
    }
  }
  const game = removeInstalled(romId);
  if (!game || !existsSync(game.dir)) return;
  if (game.created) {
    // A parent and its clones share one CHD folder: keep what another downloaded game uses.
    const key = (d: string, rel: string) => join(d, rel).toLowerCase();
    const others = listInstalled();
    const inUse = new Set(others.flatMap((g) => [...g.files, ...(g.companions ?? [])].map((f) => key(g.dir, f))));
    await removeFiles(game.dir, game.created.filter((rel) => !inUse.has(key(game.dir, rel))));
    // A kept file now belongs to a game still using it, so deleting that one later removes it.
    for (const rel of game.created.filter((r) => inUse.has(key(game.dir, r)))) {
      const owner = others.find((g) => [...g.files, ...(g.companions ?? [])].some((f) => key(g.dir, f) === key(game.dir, rel)));
      if (owner?.created) {
        const ownRel = relative(owner.dir, join(game.dir, rel));
        if (!owner.created.includes(ownRel)) putInstalled({ ...owner, created: [...owner.created, ownRel] });
      }
    }
    // A multi-file ROM's own folder goes too, once empty (a flat one shares the platform folder).
    const platformDir = platformFolder([game.platformSlug]);
    const ownFolder = resolve(game.dir).toLowerCase() !== resolve(platformDir).toLowerCase();
    if (ownFolder && (await readdir(game.dir).catch(() => ["?"])).length === 0) await rm(game.dir, { recursive: true, force: true });
  } else {
    // Installed by an earlier version, in a folder of its own (…\<slug>\<romId>).
    await rm(game.dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ launch

export async function launch(romId: number, emit: Emit, hooks: { onStart: () => void; onExit: () => void }): Promise<void> {
  if (running.has(romId)) throw new LaunchError("This game is already running.");
  const local = getInstalled(romId);
  // Offline, a downloaded game starts from its local record without asking RomM.
  const rom = isOffline() ? null : await apiGet<RomDetail>(`/api/roms/${romId}`).catch((error) => {
    noteFailure(error);
    return null;
  });
  if (!local && isOffline()) throw new LaunchError("RomM cannot be reached, so only downloaded games can be played.", "offline");
  const slugs = [rom?.platform_slug, rom?.platform_fs_slug, local?.platformSlug].filter((s): s is string => !!s);
  const resolved = resolveEmulator(slugs);
  if (!resolved) throw new LaunchError(`No emulator is set for platform "${slugs[0] ?? "unknown"}".`, "no-emulator");
  const { emulator, mapping } = resolved;
  if (!existsSync(emulator.path)) throw new LaunchError(`Emulator not found: ${emulator.path}`);

  let game = local ?? (await install(romId, emit, { extractZip: emulator.extractZip }));
  // Offline, the CHD check waits for the next launch with RomM reachable.
  if (!game.companionsChecked && isArcade(slugs) && !isOffline()) {
    const controller = new AbortController();
    jobs.set(romId, controller);
    try {
      const extra = await fetchCompanions(romId, slugs, game.dir, game.launchFile, controller.signal, emit);
      game = {
        ...game,
        companions: extra.companions,
        companionsChecked: true,
        created: game.created ? [...game.created, ...extra.created] : game.created,
        sizeBytes: game.sizeBytes + extra.bytes,
      };
      putInstalled(game);
    } catch (error) {
      if (controller.signal.aborted) throw new LaunchError("Download cancelled.");
      throw error;
    } finally {
      jobs.delete(romId);
    }
  }
  // A folder with several launchable files: ask once which one, then remember it
  // (it can be changed later in the game's detail panel).
  const candidates = launchCandidates(game.files);
  if (candidates.length > 1 && !game.launchChosen) {
    emit({ romId, type: "idle" });
    const rel = await askForFile(romId, candidates, candidates.includes(game.launchFile) ? game.launchFile : candidates[0]!, emit);
    if (rel === null) throw new LaunchError("Launch cancelled.", "cancelled");
    game = { ...game, launchFile: rel, launchChosen: true };
    putInstalled(game);
  }
  const romPath = join(game.dir, game.launchFile);
  // Save sync: pin/locate the save files, then bring newer server copies down
  // before the emulator can open them. A sync problem never blocks the game.
  let saveCtx: SyncContext | null = null;
  let extraArgs: string[] = [];
  try {
    const setup = await prepareSaves(emulator, mapping, game);
    extraArgs = setup.extraArgs;
    if (loadConfig().syncSaves && setup.ctx && isOffline()) {
      // Local saves are used as they are; they upload once RomM is back.
      saveCtx = setup.ctx;
      emit({ romId, type: "notice", message: "Offline: saves will sync with RomM when it is reachable again.", level: "" });
    } else if (loadConfig().syncSaves && setup.ctx) {
      saveCtx = setup.ctx;
      emit({ romId, type: "progress", label: "Syncing saves…", received: 0, total: 0 });
      const report = await pullSaves(saveCtx, gameSaveDir(game.platformSlug, romId));
      const note = describe(report, "pull");
      if (note) emit({ romId, type: "notice", message: note, level: report.errors.length ? "error" : "ok" });
    }
  } catch (error) {
    emit({ romId, type: "notice", message: `Save sync skipped: ${(error as Error).message}`, level: "error" });
  }
  const args = [...extraArgs, ...buildArgs(emulator, mapping.args?.trim() || emulator.args, { rom: romPath, core: mapping.core })];
  console.info(`[launch] ${emulator.path} ${args.map((a) => JSON.stringify(a)).join(" ")}`);

  const started = Date.now();
  const isScript = /\.(bat|cmd)$/i.test(emulator.path);
  const quote = (s: string) => (/[\s"&|<>^()]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const child = isScript
    ? spawn([emulator.path, ...args].map(quote).join(" "), { cwd: dirname(emulator.path), shell: true, stdio: "ignore", windowsVerbatimArguments: true })
    : spawn(emulator.path, args, { cwd: dirname(emulator.path), detached: false, stdio: "ignore", windowsHide: false });
  running.set(romId, child);
  putInstalled({ ...game, lastPlayed: started });

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => {
      emit({ romId, type: "running", emulator: emulator.name });
      hooks.onStart();
      resolve();
    });
    child.once("error", (error) => {
      running.delete(romId);
      reject(new LaunchError(`Could not start ${emulator.name}: ${error.message}`));
    });
  });
  child.once("exit", (code) => {
    running.delete(romId);
    const ended = Date.now();
    emit({ romId, type: "exited", code, seconds: Math.round((ended - started) / 1000) });
    recordSession(romId, started, ended);
    hooks.onExit();
    if (saveCtx) void syncAfterExit(saveCtx, romId, emit);
  });
}

const pushing = new Set<number>();

async function syncAfterExit(ctx: SyncContext, romId: number, emit: Emit): Promise<void> {
  pushing.add(romId);
  try {
    // Some emulators flush the save a moment after their window closes.
    await new Promise((r) => setTimeout(r, 1500));
    const markPending = () => {
      const game = getInstalled(romId);
      if (game && !game.savesPending) putInstalled({ ...game, savesPending: true });
    };
    if (isOffline() || !(await checkServer())) {
      markPending();
      emit({ romId, type: "notice", message: "Offline: saves stay on this PC and upload when RomM is reachable again.", level: "" });
      return;
    }
    const report = await pushSaves(ctx);
    // Upload errors are caught inside pushSaves; a server gone away mid-upload is retried later.
    if (report.errors.length && !(await checkServer())) markPending();
    const note = describe(report, "push");
    if (note) emit({ romId, type: "notice", message: note, level: report.errors.length ? "error" : "ok" });
  } finally {
    pushing.delete(romId);
  }
}

/** Sync a downloaded game's saves without launching it (pull then push). */
export async function syncNow(romId: number, emit: Emit): Promise<string> {
  const game = getInstalled(romId);
  if (!game) throw new LaunchError("Download the game first: saves are matched to its files.");
  const resolved = resolveEmulator([game.platformSlug]);
  if (!resolved) throw new LaunchError(`No emulator is set for platform "${game.platformSlug}".`, "no-emulator");
  if (running.has(romId) || pushing.has(romId)) throw new LaunchError("The game is running; saves sync when it exits.");
  const { ctx } = await prepareSaves(resolved.emulator, resolved.mapping, game);
  if (!ctx) throw new LaunchError(`Save sync is off for ${resolved.emulator.name}. Set it under Settings → Emulators.`);
  const pulled = await pullSaves(ctx, gameSaveDir(game.platformSlug, romId));
  const pushed = await pushSaves(ctx);
  const merged = { downloaded: pulled.downloaded, uploaded: pushed.uploaded, conflicts: [...pulled.conflicts, ...pushed.conflicts], errors: [...pulled.errors, ...pushed.errors] };
  return [describe(merged, "pull"), merged.uploaded.length ? `Uploaded ${merged.uploaded.length} file(s)` : null].filter(Boolean).join(". ") || "Saves already in sync.";
}

/** Change which downloaded file is handed to the emulator. */
export function setLaunchFile(romId: number, rel: string): InstalledGame | null {
  const game = getInstalled(romId);
  if (!game || !game.files.includes(rel)) return null;
  const next = { ...game, launchFile: rel, launchChosen: true };
  putInstalled(next);
  return next;
}
