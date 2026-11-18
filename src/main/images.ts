// Cover art proxy.
//
// The renderer asks for `romm-img://img/?s=<server path>&u=<external url>`, either
// part optional. The server copy (RomM's own resources, fetched with the auth
// header) is tried first, then the external one (IGDB, ScreenScraper, libretro
// thumbnails…, fetched without credentials). This is the same fallback RomM's web
// interface uses: a server can list a local cover whose file is not on its disk.
//
// Whatever loads is kept on disk under the pair, so a second visit is instant and
// offline, and a missing server file is only asked for once.

import { app, protocol } from "electron";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { apiFetch, apiSession } from "./api";

export const IMAGE_SCHEME = "romm-img";

const cacheDir = () => join(app.getPath("userData"), "image-cache");

type Image = { body: Buffer; type: string };

export function registerImageSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

const isExternal = (s: string) => /^https?:\/\//i.test(s);

/** Image type from the first bytes: servers often send covers as octet-stream. */
function sniff(body: Buffer): string | null {
  if (body.subarray(0, 4).toString("hex") === "89504e47") return "image/png";
  if (body.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
  if (body.subarray(0, 4).toString() === "RIFF" && body.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (body.subarray(0, 3).toString() === "GIF") return "image/gif";
  if (body.subarray(0, 4).toString("hex") === "00000100") return "image/x-icon";
  const head = body.subarray(0, 300).toString("utf8").trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return null;
}

// ------------------------------------------------------------ concurrency

// Chromium opens at most 6 connections per server. Covers are capped below that so
// a page of covers can never queue the game-list request behind it.
const MAX_PARALLEL = 4;
let active = 0;
const waiting: Array<() => void> = [];
function acquire(): Promise<void> {
  if (active < MAX_PARALLEL) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(() => { active++; resolve(); }));
}
function release(): void {
  active--;
  waiting.shift()?.();
}

// ------------------------------------------------------------------ fetch

/** Sources that failed this session (404, not an image…): not asked for again until restart. */
const failed = new Set<string>();

async function fetchOne(source: string): Promise<Image | null> {
  if (failed.has(source)) return null;
  await acquire();
  try {
    const init = { headers: { Accept: "image/*" }, signal: AbortSignal.timeout(20_000) };
    // External images get no credentials: the RomM auth header only ever goes to RomM.
    const response = isExternal(source)
      ? await apiSession().fetch(source, { ...init, credentials: "omit" } as RequestInit)
      : await apiFetch(source, init);
    if (!response.ok) {
      console.warn(`[images] ${source} → HTTP ${response.status}`);
      if (response.status === 404 || response.status === 410 || response.status === 403) failed.add(source);
      return null;
    }
    const body = Buffer.from(await response.arrayBuffer());
    const header = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
    const type = header.startsWith("image/") ? header : sniff(body);
    if (!type || body.length === 0) {
      console.warn(`[images] ${source} is not an image (${header || "no content-type"})`);
      failed.add(source);
      return null;
    }
    return { body, type };
  } catch (error) {
    console.warn(`[images] ${source}: ${(error as Error).message}`);
    return null; // network trouble: may work next time, so not remembered as failed
  } finally {
    release();
  }
}

async function load(server: string, external: string): Promise<Image | null> {
  const key = createHash("sha1").update(`${server}\n${external}`).digest("hex");
  const target = join(cacheDir(), key + ".img");
  if (existsSync(target)) {
    const body = await readFile(target);
    return { body, type: sniff(body) ?? "image/png" };
  }
  for (const source of [server, external]) {
    if (!source) continue;
    const image = await fetchOne(source);
    if (image) {
      mkdirSync(cacheDir(), { recursive: true });
      await writeFile(target, image.body).catch(() => undefined);
      return image;
    }
  }
  return null;
}

const inflight = new Map<string, Promise<Image | null>>();

export function registerImageProtocol(): void {
  protocol.handle(IMAGE_SCHEME, async (request) => {
    const url = new URL(request.url);
    const server = url.searchParams.get("s") ?? "";
    const external = url.searchParams.get("u") ?? "";
    // The server part must be a path on the RomM server, the external one an http(s) URL.
    if ((server && !server.startsWith("/")) || (external && !isExternal(external)) || (!server && !external)) {
      return new Response(null, { status: 400 });
    }
    const id = `${server}\n${external}`;
    try {
      let job = inflight.get(id);
      if (!job) {
        job = load(server, external).finally(() => inflight.delete(id));
        inflight.set(id, job);
      }
      const result = await job;
      if (!result) return new Response(null, { status: 404 });
      return new Response(new Uint8Array(result.body), {
        headers: { "Content-Type": result.type, "Cache-Control": "max-age=31536000" },
      });
    } catch {
      return new Response(null, { status: 502 });
    }
  });
}

export async function imageCacheSize(): Promise<number> {
  try {
    const names = await readdir(cacheDir());
    let total = 0;
    for (const name of names) total += (await stat(join(cacheDir(), name))).size;
    return total;
  } catch {
    return 0;
  }
}

export async function clearImageCache(): Promise<void> {
  failed.clear();
  await rm(cacheDir(), { recursive: true, force: true });
}
