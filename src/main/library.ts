// Index of games downloaded to this PC. Only downloaded games are recorded —
// the RomM library itself is always browsed live, never mirrored.

import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface InstalledGame {
  romId: number;
  name: string;
  platformSlug: string;
  platformName: string;
  /** Absolute folder holding the game's files. */
  dir: string;
  /** Paths relative to `dir`. */
  files: string[];
  /** Files this launcher created (missing on installs from older versions). */
  created?: string[];
  /** Relative path handed to the emulator. */
  launchFile: string;
  /** Files the game needs besides its own, relative to dir: a MAME set's CHD folder. */
  companions?: string[];
  /** The server was asked for this game's companion files (CHDs), so not again at every launch. */
  companionsChecked?: boolean;
  /** The user picked launchFile among several candidates (so do not ask again). */
  launchChosen?: boolean;
  sizeBytes: number;
  coverPath: string | null;
  /** External cover (url_cover), used when the server has no file for coverPath. */
  coverUrl?: string | null;
  installedAt: number;
  lastPlayed: number | null;
}

const file = () => join(app.getPath("userData"), "installed.json");
let index: Record<string, InstalledGame> | null = null;

function load(): Record<string, InstalledGame> {
  if (index) return index;
  try {
    index = existsSync(file()) ? JSON.parse(readFileSync(file(), "utf8")) : {};
  } catch {
    index = {};
  }
  return index!;
}

function persist(): void {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(file() + ".tmp", JSON.stringify(load(), null, 2), "utf8");
  renameSync(file() + ".tmp", file());
}

export function getInstalled(romId: number): InstalledGame | null {
  const game = load()[String(romId)];
  if (!game) return null;
  if (!existsSync(join(game.dir, game.launchFile))) return null;
  return game;
}

export function listInstalled(): InstalledGame[] {
  return Object.values(load()).sort((a, b) => (b.lastPlayed ?? b.installedAt) - (a.lastPlayed ?? a.installedAt));
}

export function putInstalled(game: InstalledGame): void {
  load()[String(game.romId)] = game;
  persist();
}

export function removeInstalled(romId: number): InstalledGame | null {
  const game = load()[String(romId)] ?? null;
  delete load()[String(romId)];
  persist();
  return game;
}
