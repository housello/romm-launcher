// Where the launcher keeps its files, and how relative paths are read.
//
// Local mode (the default): EVERYTHING lives in a "RomM Launcher Data" folder next
// to RomM-Launcher.exe: settings, login (encrypted, see config.ts), downloaded-games
// list, save-sync records, caches and Electron's own files. Relative paths (ROM and
// save folders, emulators, per-platform folders) are relative to the exe's folder,
// with defaults "roms" and "saves". Replacing the exe keeps everything.
//
// AppData mode: switched on by a file named "appdata" (or "appdata.txt") next to the
// exe, which Settings → Storage writes. Everything lives in %APPDATA%\romm-launcher.
// Running from source (no exe folder) is always AppData mode.
//
// The portable exe unpacks itself to a temp folder at every start, so its real
// folder comes from PORTABLE_EXECUTABLE_DIR (set by electron-builder's launcher),
// not from process.execPath. ROMM_LAUNCHER_PORTABLE simulates it in development.

import { app } from "electron";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** The folder the exe lives in (null when running from source without the override). */
function exeFolder(): string | null {
  if (process.env.ROMM_LAUNCHER_PORTABLE) return process.env.ROMM_LAUNCHER_PORTABLE;
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  return app.isPackaged ? dirname(process.execPath) : null;
}

const APPDATA_MARKERS = ["appdata", "appdata.txt"];
const LOCAL_FOLDER = "RomM Launcher Data";

const exeDir = exeFolder();

/** The exe's folder in local mode, else null. */
export const portableDir: string | null =
  exeDir && !APPDATA_MARKERS.some((m) => existsSync(join(exeDir, m))) ? exeDir : null;

export const isPortable = (): boolean => portableDir !== null;

/** Whether the data location can be switched (false when running from source). */
export const canSwitchLocation = (): boolean => exeDir !== null;

let appDataCache: string | null = null;

/** %APPDATA%\romm-launcher (or the test override), read before local mode moves userData. */
const appDataDir = (): string => (appDataCache ??= app.getPath("userData"));

/** All the launcher's own files (Electron's userData, moved next to the exe in local mode). */
export function dataDir(): string {
  return app.getPath("userData");
}

/** What relative paths are relative to: the exe's folder in local mode. */
export function baseDir(): string {
  return portableDir ?? app.getPath("userData");
}

/** A stored path (absolute or relative) as an absolute path. */
export function resolvePath(p: string | undefined | null): string {
  const x = (p ?? "").trim();
  if (!x) return x;
  return isAbsolute(x) ? x : resolve(baseDir(), x);
}

/** `p` relative to `dir` when inside it, else as is. */
function relativeTo(dir: string, p: string): string {
  const rel = relative(dir, resolve(dir, p));
  if (!rel) return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return p;
  return rel;
}

/** The form to store a path in: relative when local and inside the exe's folder, else as is. */
export function toStored(p: string | null | undefined): string {
  const x = (p ?? "").trim();
  if (!portableDir || !x) return x;
  return relativeTo(portableDir, x);
}

/** Files carried to the other location (the login is not: see setupDataFolder). */
const CARRY_OVER = [
  "launcher-config.json",
  "installed.json",
  "save-sync.json",
  "mame-rename-undo.json",
  "last-versions.json",
  "folder-sync.json",
  "play-sessions.json",
  "game-emulators.json",
];

type PathMap = (p: string) => string;

/** Rewrite the stored paths in one carried-over file, for the location it moves to. */
function rewritePaths(name: string, text: string, map: PathMap, toLocal: boolean): string {
  const data = JSON.parse(text);
  const fix = (p: unknown) => (typeof p === "string" && p.trim() ? map(p) : p);
  if (name === "launcher-config.json") {
    // Encrypted with a key kept per data folder: entered again after a move.
    delete data.passwordEnc;
    delete data.token;
    const same = (a: unknown, b: string) => typeof a === "string" && resolve(a).toLowerCase() === resolve(b).toLowerCase();
    if (toLocal) {
      // The AppData default folders become the local defaults; folders you chose stay.
      if (!data.romDir || same(data.romDir, join(appDataDir(), "roms"))) data.romDir = "roms";
      if (!data.saveDir || same(data.saveDir, join(appDataDir(), "saves"))) data.saveDir = "saves";
    }
    data.romDir = fix(data.romDir);
    data.saveDir = fix(data.saveDir);
    data.emulatorDir = fix(data.emulatorDir);
    for (const emulator of data.emulators ?? []) emulator.path = fix(emulator.path);
    for (const mapping of Object.values(data.platforms ?? {}) as Array<{ folder?: string }>) {
      if (mapping.folder) mapping.folder = fix(mapping.folder) as string;
    }
    return JSON.stringify(data, null, 2);
  }
  if (name === "installed.json") {
    for (const game of Object.values(data) as Array<{ dir?: string }>) game.dir = fix(game.dir) as string;
    return JSON.stringify(data, null, 2);
  }
  if (name === "save-sync.json") {
    // Keyed by "romId|kind|path", the path lowercased.
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      const [romId, kind, ...rest] = key.split("|");
      out[[romId, kind, String(fix(rest.join("|"))).toLowerCase()].join("|")] = value;
    }
    return JSON.stringify(out, null, 1);
  }
  return text;
}

/** Copy the carried-over files from one data folder to another, rewriting their paths. */
function carryOver(from: string, to: string, toLocal: boolean): void {
  if (!exeDir) return;
  const map: PathMap = toLocal ? (p) => relativeTo(exeDir, p) : (p) => resolve(exeDir, p);
  mkdirSync(to, { recursive: true });
  for (const name of CARRY_OVER) {
    const source = join(from, name);
    if (!existsSync(source)) continue;
    try {
      writeFileSync(join(to, name), rewritePaths(name, readFileSync(source, "utf8"), map, toLocal), "utf8");
    } catch {
      // Unreadable JSON: copied as is, its loader falls back to defaults.
      copyFileSync(source, join(to, name));
    }
  }
}

/**
 * Must run before the app is ready. In local mode, points Electron's userData at
 * the folder next to the exe; on its first start, copies the settings from AppData
 * so server, emulators, platforms and downloaded games carry over. Copied, not
 * moved: AppData stays as it was.
 */
export function setupDataFolder(): void {
  appDataDir();
  if (!portableDir) return;
  const target = join(portableDir, LOCAL_FOLDER);
  const first = !existsSync(join(target, "launcher-config.json"));
  mkdirSync(target, { recursive: true });
  app.setPath("userData", target);
  if (!first || !existsSync(join(appDataDir(), "launcher-config.json"))) return;
  carryOver(appDataDir(), target, true);
  console.info(`[data] settings copied from ${appDataDir()} to ${target}`);
}

/**
 * Move to the other data location: copy the settings there, set or clear the
 * "appdata" marker, and restart. The login is entered again afterwards.
 */
export function switchDataLocation(toLocal: boolean): void {
  if (!exeDir) throw new Error("The data location can only change in the packaged launcher.");
  if (toLocal === isPortable()) return;
  if (toLocal) {
    carryOver(dataDir(), join(exeDir, LOCAL_FOLDER), true);
    for (const marker of APPDATA_MARKERS) rmSync(join(exeDir, marker), { force: true });
  } else {
    carryOver(dataDir(), appDataDir(), false);
    writeFileSync(join(exeDir, "appdata"), "Keep RomM Launcher's data in %APPDATA%\\romm-launcher.\r\n");
  }
  // The portable exe runs from a temp copy; restart the real one.
  const execPath = process.env.PORTABLE_EXECUTABLE_FILE;
  app.relaunch(execPath ? { execPath } : undefined);
  app.exit(0);
}

/** Where each location keeps its data, for the settings page. */
export function dataLocations(): { local: string | null; appData: string } {
  return { local: exeDir ? join(exeDir, LOCAL_FOLDER) : null, appData: appDataDir() };
}
