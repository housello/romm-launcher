// Where the launcher keeps its files, and how relative paths are read.
//
// Normal mode: everything lives in AppData (%APPDATA%\romm-launcher).
//
// Portable mode: switched on by a file named "portable" (or "portable.txt") next to
// the exe. Then EVERYTHING lives in a "RomM Launcher Data" folder next to the exe:
// settings, login (encrypted, see config.ts), downloaded-games list, save-sync
// records, caches and Electron's own files. Relative paths (ROM and save folders,
// emulators, per-platform folders) are relative to the exe's folder, with defaults
// "roms" and "saves".
//
// The portable exe unpacks itself to a temp folder at every start, so its real
// folder comes from PORTABLE_EXECUTABLE_DIR (set by electron-builder's launcher),
// not from process.execPath. ROMM_LAUNCHER_PORTABLE simulates it in development.

import { app } from "electron";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** The folder the exe lives in (null when running from source without the override). */
function exeFolder(): string | null {
  if (process.env.ROMM_LAUNCHER_PORTABLE) return process.env.ROMM_LAUNCHER_PORTABLE;
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  return app.isPackaged ? dirname(process.execPath) : null;
}

const MARKERS = ["portable", "portable.txt"];

/** The exe's folder when portable mode is on (a "portable" file is there), else null. */
export const portableDir: string | null = (() => {
  const dir = exeFolder();
  return dir && MARKERS.some((m) => existsSync(join(dir, m))) ? dir : null;
})();

export const isPortable = (): boolean => portableDir !== null;

/** All the launcher's own files (Electron's userData, moved next to the exe when portable). */
export function dataDir(): string {
  return app.getPath("userData");
}

/** What relative paths are relative to: the exe's folder when portable. */
export function baseDir(): string {
  return portableDir ?? app.getPath("userData");
}

/** A stored path (absolute or relative) as an absolute path. */
export function resolvePath(p: string | undefined | null): string {
  const x = (p ?? "").trim();
  if (!x) return x;
  return isAbsolute(x) ? x : resolve(baseDir(), x);
}

/** The form to store a path in: relative when portable and inside the exe's folder, else as is. */
export function toStored(p: string | null | undefined): string {
  const x = (p ?? "").trim();
  if (!portableDir || !x) return x;
  const rel = relative(portableDir, resolve(portableDir, x));
  if (!rel) return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return x;
  return rel;
}

/** Settings carried over from AppData on the first portable start (the login is not: see below). */
const CARRY_OVER = ["launcher-config.json", "installed.json", "save-sync.json", "mame-rename-undo.json"];

/**
 * Must run before the app is ready. In portable mode, points Electron's userData at
 * the folder next to the exe; on its first start, copies the settings from AppData
 * so server, emulators, platforms and downloaded games carry over. The login does
 * not: it is encrypted with a key Electron keeps per data folder, so it is entered
 * once more. Copied, not moved: AppData stays as it was.
 */
export function setupDataFolder(): void {
  if (!portableDir) return;
  const appData = app.getPath("userData");
  const target = join(portableDir, "RomM Launcher Data");
  const first = !existsSync(join(target, "launcher-config.json"));
  mkdirSync(target, { recursive: true });
  app.setPath("userData", target);
  if (!first || !existsSync(join(appData, "launcher-config.json"))) return;
  for (const name of CARRY_OVER) {
    const from = join(appData, name);
    if (existsSync(from)) copyFileSync(from, join(target, name));
  }
  // Older settings files held the encrypted login; it cannot be decrypted here.
  try {
    const file = join(target, "launcher-config.json");
    const settings = JSON.parse(readFileSync(file, "utf8"));
    delete settings.passwordEnc;
    delete settings.token;
    // The AppData default folders become the portable defaults; folders you chose stay.
    const same = (a: unknown, b: string) => typeof a === "string" && resolve(a).toLowerCase() === resolve(b).toLowerCase();
    if (!settings.romDir || same(settings.romDir, join(appData, "roms"))) settings.romDir = "roms";
    if (!settings.saveDir || same(settings.saveDir, join(appData, "saves"))) settings.saveDir = "saves";
    writeFileSync(file, JSON.stringify(settings, null, 2), "utf8");
  } catch {
    /* unreadable: the settings loader falls back to defaults */
  }
  console.info(`[portable] settings copied from ${appData} to ${target}`);
}
