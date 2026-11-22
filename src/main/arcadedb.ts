// Arcade Database (https://adb.arcadeitalia.net, by motoschifo): details, history, images,
// screenshots and manuals for MAME romsets, written to the RomM games the MAME tool matched.
//
// The author allowed this use. Their guidelines, followed here: one request at a time,
// one romset per request, results kept locally (arcadedb-cache.json) so the same set is
// not asked for twice, no retries for names they don't know (HTTP 400/404), and HTTP
// status codes handled (509 = bandwidth limit: stop). The history text is shown with
// its copyright line, and the source is credited.

import { net } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { apiFetch, apiGet } from "./api";
import { dataDir } from "./paths";

const API = "https://adb.arcadeitalia.net/service_scraper.php";
const UA = { "User-Agent": "RomM-Launcher (+https://github.com/housello/romm-launcher)" };
const GAP_MS = 250;
export const CREDIT = "Arcade Database by motoschifo (adb.arcadeitalia.net)";

export type CoverKind = "flyer" | "title" | "ingame" | "cabinet" | "marquee" | "box" | "logo";
export type ShotKind = "ingame" | "title" | "select" | "versus" | "boss" | "gameover" | "end" | "score" | "howto";

export interface AdbOptions {
  /** Year, manufacturer, genre, series, video: into RomM's manual metadata. */
  details: boolean;
  /** The history text as the game's summary, with its copyright line. */
  history: boolean;
  /** Which image becomes the cover, or null. */
  cover: CoverKind | null;
  /** Which images are uploaded as screenshots. */
  screenshots: ShotKind[];
  /** The manual (PDF), when there is one. */
  manual: boolean;
}

interface CacheEntry {
  at: number;
  /** query_mame's result, or null for a set they don't know. */
  info: Record<string, any> | null;
  /** query_mame_media's result, fetched only when screenshots or the manual are wanted. */
  media?: Record<string, any> | null;
}

const cacheFile = () => join(dataDir(), "arcadedb-cache.json");
let cache: Record<string, CacheEntry> | null = null;
const loadCache = () => (cache ??= existsSync(cacheFile()) ? (JSON.parse(readFileSync(cacheFile(), "utf8")) as Record<string, CacheEntry>) : {});
const saveCache = () => writeFile(cacheFile(), JSON.stringify(cache ?? {}));

export class AdbLimitError extends Error {}

let last = 0;
/** One request at a time, a short gap between them. */
async function request(params: Record<string, string>): Promise<Record<string, any> | null> {
  const wait = last + GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const response = await net.fetch(`${API}?${new URLSearchParams(params)}`, { headers: UA });
  if (response.status === 400 || response.status === 404) return null;
  if (response.status === 509 || response.status === 429) throw new AdbLimitError("Arcade Database's bandwidth limit for now is reached; try again later.");
  if (response.status === 503) throw new AdbLimitError("Arcade Database is in maintenance; try again later.");
  if (!response.ok) throw new Error(`Arcade Database answered HTTP ${response.status}`);
  let body = Buffer.from(await response.arrayBuffer());
  // Answers come gzip-compressed without a Content-Encoding header.
  if (body[0] === 0x1f && body[1] === 0x8b) body = gunzipSync(body);
  const json = JSON.parse(body.toString("utf8")) as { result?: Array<Record<string, any>> };
  return json.result?.[0] ?? null;
}

/** A romset's data, from the local cache or, once, from Arcade Database. */
export async function lookup(name: string, withMedia: boolean): Promise<CacheEntry> {
  const key = name.toLowerCase();
  const all = loadCache();
  let entry = all[key];
  if (!entry) {
    entry = { at: Date.now(), info: await request({ ajax: "query_mame", game_name: key }) };
    all[key] = entry;
    await saveCache();
  }
  if (withMedia && entry.info && entry.media === undefined) {
    entry.media = await request({ ajax: "query_mame_media", game_name: key });
    await saveCache();
  }
  return entry;
}

/** The history text with the copyright line Arcade Database asks to show under it. */
function historyText(info: Record<string, any>): string {
  const text = String(info.history ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  const copyright = String(info.history_copyright_short || info.history_copyright_long || "").trim();
  return [text, "", copyright, `Source: ${CREDIT}`].filter((l, i) => l || i === 1).join("\n");
}

/** RomM's manual metadata from Arcade Database's details, merged into what the game has. */
function details(info: Record<string, any>, media: Record<string, any> | null | undefined, current: Record<string, any> | null): Record<string, any> {
  const next: Record<string, any> = { ...(current ?? {}) };
  const year = /^\d{4}$/.test(String(info.year ?? "")) ? Number(info.year) : null;
  if (year) next.first_release_date = Date.UTC(year, 0, 1);
  if (info.manufacturer) next.companies = [String(info.manufacturer)];
  if (info.genre) next.genres = String(info.genre).split(/\s*\/\s*/).filter(Boolean);
  if (info.serie) next.franchises = [String(info.serie)];
  if (Number(info.players) > 0) next.game_modes = Number(info.players) > 1 ? ["Single player", "Multiplayer"] : ["Single player"];
  const video = media?.youtube_video_id || info.youtube_video_id;
  if (video) next.youtube_video_id = String(video);
  return next;
}

/** Update a game's fields on the server; only the fields given are sent. */
async function updateRom(id: number, fields: Record<string, string>): Promise<void> {
  const boundary = "----romm" + Math.random().toString(16).slice(2);
  const parts = Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  const response = await apiFetch(`/api/roms/${id}`, {
    method: "PUT",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: Buffer.from(parts.join("") + `--${boundary}--\r\n`, "utf8"),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`RomM refused the update (HTTP ${response.status})`);
}

/** Download an image from Arcade Database and upload it as one of the game's screenshots. */
async function uploadScreenshot(id: number, url: string, fileName: string): Promise<void> {
  const wait = last + GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const image = await net.fetch(url, { headers: UA });
  if (image.status === 509 || image.status === 429) throw new AdbLimitError("Arcade Database's download limit for now is reached; try again later.");
  if (!image.ok) return;
  const body = Buffer.from(await image.arrayBuffer());
  if (body.length < 100) return;
  const response = await apiFetch(`/api/roms/${id}/screenshots`, {
    method: "POST",
    headers: { "x-upload-filename": fileName, "Content-Type": image.headers.get("content-type") ?? "image/png" },
    body,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`RomM refused the screenshot (HTTP ${response.status})`);
}

export interface AdbReport {
  updated: number;
  notFound: string[];
  failed: Array<{ file: string; error: string }>;
  stopped?: string;
}

/** Fetch and write Arcade Database data for the matched games, one at a time. */
export async function applyArcadeDb(
  games: Array<{ id: number; set: string }>,
  options: AdbOptions,
  progress: (label: string, fraction: number) => void,
): Promise<AdbReport> {
  const report: AdbReport = { updated: 0, notFound: [], failed: [] };
  const wantMedia = options.screenshots.length > 0 || options.manual;
  for (const [i, game] of games.entries()) {
    progress(`Arcade Database ${i + 1}/${games.length}: ${game.set}`, i / games.length);
    try {
      const { info, media } = await lookup(game.set, wantMedia);
      if (!info) {
        report.notFound.push(game.set);
        continue;
      }
      const fields: Record<string, string> = {};
      if (options.history) {
        const text = historyText(info);
        if (text) fields.summary = text;
      }
      if (options.cover) {
        const url = info[`url_image_${options.cover}`] || media?.[`url_image_${options.cover}`];
        if (url) fields.url_cover = String(url);
      }
      if (options.manual && media?.url_manual) fields.url_manual = String(media.url_manual);
      if (options.details) {
        const rom = await apiGet<{ manual_metadata?: Record<string, any> | null }>(`/api/roms/${game.id}`);
        fields.raw_manual_metadata = JSON.stringify(details(info, media, rom.manual_metadata ?? null));
      }
      if (Object.keys(fields).length) await updateRom(game.id, fields);
      if (options.screenshots.length && media) {
        const rom = await apiGet<{ path_screenshots?: string[] }>(`/api/roms/${game.id}`);
        const existing = (rom.path_screenshots ?? []).map((p) => p.split(/[\\/]/).pop()?.toLowerCase());
        for (const kind of options.screenshots) {
          const url = media[`url_image_${kind}`];
          const fileName = `arcadedb-${game.set}-${kind}.png`;
          // Already uploaded by an earlier run: not again.
          if (url && !existing.includes(fileName.toLowerCase())) await uploadScreenshot(game.id, String(url), fileName);
        }
      }
      report.updated++;
    } catch (error) {
      if (error instanceof AdbLimitError) {
        report.stopped = error.message;
        break;
      }
      report.failed.push({ file: game.set, error: (error as Error).message });
      if (/HTTP 40[13]/.test((error as Error).message)) break;
    }
  }
  progress("Done", 1);
  return report;
}
