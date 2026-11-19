// Which version of each game was played last, so Play can start it without asking.
// Kept in last-versions.json in the data folder: version id -> the version id
// played last in its group. Every version of a group points at the same choice,
// so whichever version the server picks to represent the game finds it.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths";

type LastVersions = Record<string, number>;

const file = () => join(dataDir(), "last-versions.json");

let cache: LastVersions | null = null;

function load(): LastVersions {
  if (cache) return cache;
  try {
    cache = existsSync(file()) ? (JSON.parse(readFileSync(file(), "utf8")) as LastVersions) : {};
  } catch {
    cache = {};
  }
  return cache;
}

/** Every remembered choice, keyed by version id. */
export function lastVersions(): LastVersions {
  return { ...load() };
}

/** Remember that `chosen` was played among `versionIds` (the versions of one game). */
export function rememberVersion(versionIds: number[], chosen: number): LastVersions {
  const map = load();
  for (const id of new Set([...versionIds, chosen])) map[String(id)] = chosen;
  // Written to a temp file first, so a crash never leaves a half-written file.
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify(map));
  renameSync(tmp, file());
  return { ...map };
}
