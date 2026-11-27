// A game's manuals, guides, soundtracks, screenshots and videos, as RomM keeps them:
// files uploaded to the game (category manual / walkthrough / soundtrack / screenshot,
// in sub-folders of the game, not downloaded with it), the manual a metadata provider
// gave (path_manual, a server resource, or url_manual, a web page), and its video
// (path_video, or a YouTube id). Opening one downloads it once into the data folder
// (media\<game id>\…) and hands it to the program Windows uses for that kind of file.

import { shell } from "electron";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { apiFetch, apiGet } from "./api";
import { dataDir } from "./paths";

export type MediaKind = "manual" | "guide" | "soundtrack" | "screenshot" | "video";

export interface MediaItem {
  /** Stable within the game: f<file id>, manual, manual-web, video, youtube. */
  key: string;
  kind: MediaKind;
  name: string;
  size: number;
  /** "file"/"resource": downloaded and opened here; "web": opened in the browser. */
  source: "file" | "resource" | "web";
  /** Already downloaded to this PC. */
  local?: boolean;
}

const KIND_OF: Record<string, MediaKind> = { manual: "manual", walkthrough: "guide", soundtrack: "soundtrack", screenshot: "screenshot" };
const RESOURCES = "/assets/romm/resources";

const safeName = (name: string) => basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 180) || "file";
const folderOf = (romId: number) => join(dataDir(), "media", String(romId));
const localPath = (romId: number, item: MediaItem) => join(folderOf(romId), item.kind, safeName(item.name));

interface Located extends MediaItem {
  /** Server path to download, or the web address. */
  remote: string;
}

function locate(r: any): Located[] {
  const out: Located[] = [];
  const title = String(r.name || r.fs_name_no_ext || "Game");
  for (const f of Array.isArray(r.files) ? r.files : []) {
    const kind = KIND_OF[f?.category];
    if (!kind || typeof f.id !== "number" || !f.file_name) continue;
    out.push({ key: `f${f.id}`, kind, name: f.file_name, size: f.file_size_bytes ?? 0, source: "file", remote: `/api/roms/${f.id}/files/content/${encodeURIComponent(f.file_name)}` });
  }
  if (r.path_manual) {
    // RomM names these after the game's id (7.pdf): shown with the game's name instead.
    out.push({ key: "manual", kind: "manual", name: `${title} - manual${extname(String(r.path_manual))}`, size: 0, source: "resource", remote: `${RESOURCES}/${String(r.path_manual).replace(/^\/+/, "")}` });
  } else if (/^https?:\/\//i.test(r.url_manual ?? "")) {
    out.push({ key: "manual-web", kind: "manual", name: "Manual (web page)", size: 0, source: "web", remote: r.url_manual });
  }
  if (r.path_video) out.push({ key: "video", kind: "video", name: `${title} - video${extname(String(r.path_video))}`, size: 0, source: "resource", remote: `${RESOURCES}/${String(r.path_video).replace(/^\/+/, "")}` });
  if (/^[\w-]{6,20}$/.test(r.youtube_video_id ?? "")) {
    out.push({ key: "youtube", kind: "video", name: "Video on YouTube", size: 0, source: "web", remote: `https://www.youtube.com/watch?v=${r.youtube_video_id}` });
  }
  return out;
}

/** The game's media for the details panel, from the game as RomM gave it. */
export function mediaOf(r: any): MediaItem[] {
  return locate(r).map(({ remote: _remote, ...item }) => ({ ...item, local: item.source !== "web" && existsSync(localPath(r.id, item)) }));
}

/** The item as RomM lists it now (so only the game's own media can be fetched). */
async function find(romId: number, key: string): Promise<Located> {
  const r = await apiGet<any>(`/api/roms/${romId}`);
  const item = locate(r).find((x) => x.key === key);
  if (!item) throw new Error("RomM no longer has this file for the game.");
  return item;
}

/** Download it once into the data folder; later opens use that copy. */
async function fetchLocal(romId: number, item: Located): Promise<string> {
  const dest = localPath(romId, item);
  if (existsSync(dest)) return dest;
  await mkdir(join(folderOf(romId), item.kind), { recursive: true });
  const response = await apiFetch(item.remote, { signal: AbortSignal.timeout(30 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`RomM answered HTTP ${response.status} for ${item.name}.`);
  const part = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(part));
    await rename(part, dest);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
  return dest;
}

/** Open with the program Windows uses for the file (PDF reader, player, browser…). */
export async function openMedia(romId: number, key: string): Promise<void> {
  const item = await find(romId, key);
  if (item.source === "web") {
    await shell.openExternal(item.remote);
    return;
  }
  const file = await fetchLocal(romId, item);
  const problem = await shell.openPath(file);
  if (problem) throw new Error(`Windows could not open ${item.name}: ${problem}`);
}

/** Download (if needed) and copy to a place the user picked. */
export async function saveMedia(romId: number, key: string, target: string): Promise<void> {
  const item = await find(romId, key);
  if (item.source === "web") throw new Error("This one is a web page; open it instead.");
  await copyFile(await fetchLocal(romId, item), target);
}

/** The folder holding the game's downloaded media (created if needed). */
export async function mediaFolder(romId: number): Promise<string> {
  await mkdir(folderOf(romId), { recursive: true });
  return folderOf(romId);
}

/** Forget a game's downloaded media (e.g. with "Delete local copy"). */
export async function removeMedia(romId: number): Promise<void> {
  await rm(folderOf(romId), { recursive: true, force: true });
}
