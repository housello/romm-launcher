// Index of games downloaded to this PC. Only downloaded games are recorded —
// the RomM library itself is always browsed live, never mirrored. Each record
// keeps a snapshot of the game's details, so it can still be shown and played
// offline. A JSON file read once into memory: it stays small (a few hundred
// bytes per game), so a database would only add start-up and write cost.

import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, resolvePath, toStored } from "./paths";

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
  /** The game's details as RomM last gave them, shown when the server is unreachable. */
  meta?: OfflineMeta;
  /** Saves changed while RomM could not be reached; uploaded once it is back. */
  savesPending?: boolean;
}

/** The offline snapshot of a RomM rom (API shape). */
export function metaOf(r: any): OfflineMeta {
  const date = r.metadatum?.first_release_date ?? r.first_release_date;
  return {
    summary: r.summary ?? "",
    year: date ? new Date(Number(date)).getFullYear() : null,
    companies: r.metadatum?.companies ?? r.companies ?? [],
    genres: r.metadatum?.genres ?? r.genres ?? [],
    regions: r.regions ?? [],
    languages: r.languages ?? [],
    cover: r.path_cover_large || r.path_cover_small || null,
  };
}

export interface OfflineMeta {
  summary: string;
  year: number | null;
  companies: string[];
  genres: string[];
  regions: string[];
  languages: string[];
  /** Larger cover than coverPath, for the detail panel. */
  cover: string | null;
}

const file = () => join(dataDir(), "installed.json");
let index: Record<string, InstalledGame> | null = null;

function load(): Record<string, InstalledGame> {
  if (index) return index;
  try {
    index = existsSync(file()) ? JSON.parse(readFileSync(file(), "utf8")) : {};
    // Folders are stored relative to the exe's folder when portable (drive letters change).
    for (const g of Object.values(index!)) g.dir = resolvePath(g.dir);
  } catch {
    index = {};
  }
  return index!;
}

function persist(): void {
  mkdirSync(dataDir(), { recursive: true });
  const stored = Object.fromEntries(Object.entries(load()).map(([k, g]) => [k, { ...g, dir: toStored(g.dir) }]));
  writeFileSync(file() + ".tmp", JSON.stringify(stored, null, 2), "utf8");
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
