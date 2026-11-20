// Where the MAME rename tool gets its XML: the user's MAME emulator (-listxml) or
// one of MAME's software lists (hash/*.xml next to mame.exe).

import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { loadConfig } from "./config";
import { dataDir, resolvePath } from "./paths";

export interface MameExe {
  id: string;
  name: string;
  path: string;
  hasHash: boolean;
}

/** The emulators in Settings that are MAME (downloaded by the launcher, or a mame*.exe added by hand). */
export function mameExes(): MameExe[] {
  return loadConfig().emulators
    .filter((e) => e.managed?.key === "mame" || /^mame(64)?\.exe$/i.test(basename(e.path || "")))
    .map((e) => {
      const path = resolvePath(e.path);
      return { id: e.id, name: e.name, path, hasHash: existsSync(join(dirname(path), "hash")) };
    })
    .filter((e) => existsSync(e.path));
}

function exeOf(id: string): MameExe {
  const exe = mameExes().find((e) => e.id === id);
  if (!exe) throw new Error("MAME is not in Settings → Emulators (or its exe is missing). Add or download it there first.");
  return exe;
}

const cacheDir = () => join(dataDir(), "mame-cache");

/**
 * `mame -listxml`, written to a cache file and reused while the same mame.exe is
 * installed (same size and date). Returns the XML's path.
 */
export async function listXmlFromExe(id: string, progress: (label: string, fraction: number) => void): Promise<string> {
  const exe = exeOf(id);
  const info = await stat(exe.path);
  const stamp = `${exe.path}|${info.size}|${info.mtimeMs}`;
  const xml = join(cacheDir(), `listxml-${id}.xml`);
  const meta = `${xml}.json`;
  if (existsSync(xml) && existsSync(meta)) {
    const saved = JSON.parse(await readFile(meta, "utf8").catch(() => "{}")) as { stamp?: string };
    if (saved.stamp === stamp) return xml;
  }
  await mkdir(cacheDir(), { recursive: true });
  const part = `${xml}.part`;
  progress(`Asking ${exe.name} for its machine list (mame -listxml)…`, 0);
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(part);
    const child = spawn(exe.path, ["-listxml"], { cwd: dirname(exe.path), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let bytes = 0;
    let last = 0;
    let errors = "";
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      const now = Date.now();
      if (now - last > 250) {
        last = now;
        // The full list is a few hundred MB; the bar is a rough guide only.
        progress(`Reading the machine list from ${exe.name}… ${Math.round(bytes / 1048576)} MB`, Math.min(0.95, bytes / (300 * 1048576)));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-400); });
    child.stdout.pipe(out);
    child.once("error", (error) => reject(new Error(`Could not start ${exe.name}: ${error.message}`)));
    child.once("close", (code) => {
      out.end(() => {
        if (code === 0 && bytes > 0) resolve();
        else reject(new Error(`${exe.name} -listxml failed (exit code ${code})${errors.trim() ? `: ${errors.trim()}` : ""}`));
      });
    });
  }).catch(async (error) => {
    await rm(part, { force: true });
    throw error;
  });
  await rm(xml, { force: true });
  await rename(part, xml);
  await writeFile(meta, JSON.stringify({ stamp, at: new Date().toISOString() }));
  return xml;
}

export interface SoftwareList {
  name: string;
  description: string;
  path: string;
}

/** The software lists in MAME's hash folder, from each file's <softwarelist> header. */
export async function softwareLists(id: string): Promise<SoftwareList[]> {
  const exe = exeOf(id);
  const dir = join(dirname(exe.path), "hash");
  if (!existsSync(dir)) throw new Error(`${exe.name} has no hash folder (${dir}).`);
  const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".xml"));
  const lists = await Promise.all(files.map(async (file) => {
    const path = join(dir, file);
    const handle = await open(path, "r");
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(4096), 0, 4096, 0);
      const head = buffer.subarray(0, bytesRead).toString("utf8").match(/<softwarelist\s[^>]*>/);
      if (!head) return null;
      const attr = (n: string) => head[0].match(new RegExp(`\\s${n}="([^"]*)"`))?.[1] ?? "";
      const name = attr("name") || file.replace(/\.xml$/i, "");
      return { name, description: attr("description").replace(/&amp;/g, "&") || name, path };
    } finally {
      await handle.close();
    }
  }));
  return lists.filter((x): x is SoftwareList => !!x).sort((a, b) => a.description.localeCompare(b.description));
}

/** RomM platform slug → the MAME software list that most likely holds its games. */
const LIST_FOR_SLUG: Record<string, string> = {
  nes: "nes", famicom: "nes", fds: "famicom_flop", snes: "snes", sfam: "snes", n64: "n64",
  gb: "gameboy", gbc: "gbcolor", gba: "gba", nds: "nds", virtualboy: "vboy", "pokemon-mini": "pokemini",
  genesis: "megadriv", "genesis-slash-megadrive": "megadriv", megadrive: "megadriv", sms: "sms", gamegear: "gamegear",
  segacd: "segacd", sega32: "32x", "sega-32x": "32x", saturn: "saturn", dc: "dc", sg1000: "sg1000",
  psx: "psx", ps: "psx", tg16: "pce", turbografx16: "pce", "turbografx-16-slash-pc-engine": "pce", pce: "pce", supergrafx: "sgx",
  atari2600: "a2600", atari5200: "a5200", atari7800: "a7800", lynx: "lynx", jaguar: "jaguar",
  colecovision: "coleco", intellivision: "intv", odyssey2: "odyssey2", vectrex: "vectrex",
  "neo-geo-pocket": "ngp", ngp: "ngp", "neo-geo-pocket-color": "ngpc", ngpc: "ngpc", neogeoaes: "neogeo",
  wonderswan: "wswan", "wonderswan-color": "wscolor", wsc: "wscolor", msx: "msx1_cart", msx2: "msx2_cart",
  c64: "c64_cart", vic20: "vic1001_cart", amiga: "amiga_flop", "3do": "3do_m2", cdi: "cdi", "philips-cd-i": "cdi",
};

export function guessList(slugs: string[], lists: SoftwareList[]): string | null {
  const names = new Set(lists.map((l) => l.name));
  for (const slug of slugs) {
    const s = (slug || "").toLowerCase();
    if (LIST_FOR_SLUG[s] && names.has(LIST_FOR_SLUG[s])) return LIST_FOR_SLUG[s];
    if (names.has(s)) return s;
  }
  return null;
}
