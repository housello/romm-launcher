// Emulator (and RetroArch core) chosen for one game, over its platform's setting.
// Kept in game-emulators.json in the data folder, keyed by RomM game id.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths";

export interface GameEmulator {
  emulatorId: string;
  /** Libretro core for the {core} placeholder; unset keeps the platform's when the emulator is the same. */
  core?: string;
}

const file = () => join(dataDir(), "game-emulators.json");

function readAll(): Record<string, GameEmulator> {
  if (!existsSync(file())) return {};
  try {
    const parsed = JSON.parse(readFileSync(file(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function gameEmulator(romId: number): GameEmulator | null {
  const choice = readAll()[String(romId)];
  return choice && typeof choice.emulatorId === "string" ? choice : null;
}

/** Remember an emulator for a game, or forget it (null) so the platform's applies again. */
export function setGameEmulator(romId: number, choice: GameEmulator | null): void {
  const all = readAll();
  if (choice) all[String(romId)] = { emulatorId: choice.emulatorId, ...(choice.core ? { core: choice.core } : {}) };
  else delete all[String(romId)];
  writeFileSync(file(), JSON.stringify(all, null, 1));
}
