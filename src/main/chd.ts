// MAME disk images (CHD) that live in a RomM rom of their own.
//
// MAME looks for a set's disks in a folder named after the set, next to the
// romset: `sfiii.zip` + `sfiii/cap-sf3-3.chd`. RomM libraries often keep the CHD
// folders on another platform folder (roms/chd), so each folder is a separate
// RomM game and downloading `sfiii.zip` would not bring its disk along.
//
// The pairing is by name, as MAME does it (approach from rommapp/desktop's
// discs/mame.ts): the folder named after the set, else for a clone (`sfiiia`) the
// longest folder name the set starts with (its parent, `sfiii`).

import { extname } from "node:path";
import { apiGet } from "./api";

/** RomM platform (fs) slugs whose games are MAME-style romsets. */
const ARCADE = new Set(["mame", "arcade", "fbneo", "fba", "neogeo", "cps1", "cps2", "cps3", "naomi", "atomiswave"]);

export function isArcade(slugs: Array<string | undefined | null>): boolean {
  return slugs.some((s) => !!s && ARCADE.has(s.toLowerCase()));
}

/** `sfiiia.zip` → `sfiiia`; null when the file is not a romset archive. */
export function setNameOf(fileName: string): string | null {
  const ext = extname(fileName).toLowerCase();
  if (ext !== ".zip" && ext !== ".7z") return null;
  const stem = fileName.slice(0, -ext.length);
  return stem ? stem.toLowerCase() : null;
}

/** Searches to run: the set name, then up to three characters shorter (a clone is its parent plus a suffix). */
export function searchTermsFor(set: string): string[] {
  const terms: string[] = [];
  for (let cut = 0; cut <= 3 && set.length - cut >= 3; cut++) terms.push(set.slice(0, set.length - cut));
  return terms;
}

export interface FolderRef {
  id: number;
  fsName: string;
}

/** The folder named after the set, else the longest folder name the set starts with. */
export function chdFolderFor(set: string, folders: FolderRef[]): FolderRef | null {
  const wanted = set.toLowerCase();
  const exact = folders.find((f) => f.fsName.toLowerCase() === wanted);
  if (exact) return exact;
  return (
    folders
      .filter((f) => f.fsName.length >= 3 && wanted.startsWith(f.fsName.toLowerCase()))
      .sort((a, b) => b.fsName.length - a.fsName.length)[0] ?? null
  );
}

interface SearchRow {
  id: number;
  fs_name: string;
  fs_extension?: string;
}

export interface ChdFile {
  id: number;
  fileName: string;
  sizeBytes: number;
}

export interface ChdFolder {
  romId: number;
  folder: string;
  files: ChdFile[];
}

/**
 * Find the CHD folder a romset needs on the server, or null when there is none.
 * Only a rom with no file extension whose files are all .chd counts as one.
 */
export async function findChdFolder(romsetFile: string): Promise<ChdFolder | null> {
  const set = setNameOf(romsetFile);
  if (!set) return null;
  const folders = new Map<number, FolderRef>();
  for (const term of searchTermsFor(set)) {
    const q = new URLSearchParams({ search_term: term, limit: "200", offset: "0" });
    const body = await apiGet<{ items?: SearchRow[] } | SearchRow[]>(`/api/roms?${q}`);
    const rows = Array.isArray(body) ? body : (body.items ?? []);
    for (const r of rows) {
      if (typeof r?.id === "number" && typeof r.fs_name === "string" && !extname(r.fs_name)) folders.set(r.id, { id: r.id, fsName: r.fs_name });
    }
    // The exact folder settles it; otherwise keep shortening to reach a parent.
    if ([...folders.values()].some((f) => f.fsName.toLowerCase() === set)) break;
  }
  const candidates = [...folders.values()].sort((a, b) => b.fsName.length - a.fsName.length);
  // Try the best match first; a folder that turns out not to hold CHDs is skipped.
  while (candidates.length) {
    const pick = chdFolderFor(set, candidates);
    if (!pick) return null;
    candidates.splice(candidates.indexOf(pick), 1);
    const detail = await apiGet<{ files?: Array<{ id: number; file_name: string; file_size_bytes?: number; category?: string | null }> }>(`/api/roms/${pick.id}`);
    // Screenshots or manuals RomM keeps with the folder are not CHDs to fetch.
    const media = new Set(["screenshot", "manual", "walkthrough", "soundtrack"]);
    const files = (detail.files ?? []).filter((f) => typeof f.id === "number" && typeof f.file_name === "string" && !media.has(f.category ?? ""));
    if (files.length && files.every((f) => extname(f.file_name).toLowerCase() === ".chd")) {
      return { romId: pick.id, folder: pick.fsName, files: files.map((f) => ({ id: f.id, fileName: f.file_name, sizeBytes: f.file_size_bytes ?? 0 })) };
    }
  }
  return null;
}
