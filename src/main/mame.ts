// Rename RomM games from a MAME XML / DAT.
//
// `mame -listxml` (and most MAME DATs) describe each set as
//   <machine name="sf2" cloneof="..."><description>Street Fighter II: …</description><year>1991</year>…
// (older files use <game> instead of <machine>). RomM stores arcade sets under
// the same short name (sf2.zip), so the file name is the key.
//
// The XML can be several hundred MB, so it is streamed and only the entries for
// the games being renamed are kept.

import { app } from "electron";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { apiFetch, apiGet } from "./api";

export interface MameEntry {
  description: string;
  year: string;
  manufacturer: string;
  cloneof: string;
  isbios: boolean;
  isdevice: boolean;
  ismechanical: boolean;
  /** runnable="no": a device or part that cannot be started on its own. */
  runnable: boolean;
  /** <driver status="good|imperfect|preliminary">, "" when the file has none. */
  driverStatus: string;
}

/** Which optional MAME attributes the file carries at all (DATs often leave some out). */
export interface FileFeatures {
  device: boolean;
  mechanical: boolean;
  driverStatus: boolean;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });

const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`));
  return m ? decode(m[1]!) : "";
};
const child = (block: string, name: string) => {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]!.trim()) : "";
};

/**
 * Read the entries for `wanted` short names (lower-case) out of a MAME XML/DAT.
 * Streams the file; memory stays proportional to the matches, not the file.
 */
export async function readMameXml(path: string, wanted: Set<string>, onProgress?: (fraction: number) => void): Promise<{ entries: Map<string, MameEntry>; machines: number; features: FileFeatures }> {
  const entries = new Map<string, MameEntry>();
  const features: FileFeatures = { device: false, mechanical: false, driverStatus: false };
  let machines = 0;
  let buffer = "";
  let read = 0;
  const { size } = await stat(path);
  const start = /<(machine|game)\s[^>]*>/g;

  const drain = (final: boolean) => {
    let consumed = 0; // end of the last complete entry
    let pending = -1; // start of an entry that continues in the next chunk
    start.lastIndex = 0;
    for (;;) {
      const m = start.exec(buffer);
      if (!m) break;
      const tagName = m[1]!;
      const open = m[0];
      // A self-closing tag has no description to read.
      if (open.endsWith("/>")) {
        consumed = start.lastIndex;
        continue;
      }
      const close = buffer.indexOf(`</${tagName}>`, start.lastIndex);
      if (close < 0) {
        pending = m.index;
        break;
      }
      machines++;
      const name = attr(open, "name").toLowerCase();
      if (name && wanted.has(name)) {
        const body = buffer.slice(start.lastIndex, close);
        const status = body.match(/<driver\s[^>]*\bstatus\s*=\s*"([^"]*)"/);
        entries.set(name, {
          description: child(body, "description"),
          year: child(body, "year"),
          manufacturer: child(body, "manufacturer"),
          cloneof: attr(open, "cloneof"),
          isbios: attr(open, "isbios") === "yes",
          isdevice: attr(open, "isdevice") === "yes",
          ismechanical: attr(open, "ismechanical") === "yes",
          runnable: attr(open, "runnable") !== "no",
          driverStatus: status ? status[1]!.toLowerCase() : "",
        });
      }
      // Whole-file features, from every entry (not only the matched ones).
      if (/\sisdevice\s*=/.test(open)) features.device = true;
      if (/\sismechanical\s*=/.test(open)) features.mechanical = true;
      if (!features.driverStatus && buffer.slice(start.lastIndex, close).includes("<driver ")) features.driverStatus = true;
      consumed = close + tagName.length + 3;
      start.lastIndex = consumed;
    }
    if (final) return;
    // Keep an unfinished entry whole; otherwise only a short tail, where an opening
    // tag may have been cut in half by the chunk boundary.
    buffer = pending >= 0 ? buffer.slice(pending) : buffer.slice(Math.max(consumed, buffer.length - 4096));
  };

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 20 });
    let last = 0;
    stream.on("data", (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      buffer += text;
      read += Buffer.byteLength(text);
      drain(false);
      const now = Date.now();
      if (onProgress && now - last > 200) {
        last = now;
        onProgress(Math.min(1, read / size));
      }
    });
    stream.on("end", () => {
      drain(true);
      resolve();
    });
    stream.on("error", reject);
  });
  if (machines === 0) throw new Error("No <machine> or <game> entries found: is this a MAME XML / DAT file?");
  return { entries, machines, features };
}

/** "Street Fighter II: The World Warrior (World 910522)" → "Street Fighter II: The World Warrior" */
export function cleanTitle(description: string): string {
  let s = description;
  // Repeat to remove "(a) (b)" and nested trailing groups; only trailing ones, so
  // titles with brackets in the middle keep their meaning.
  for (let i = 0; i < 5; i++) s = s.replace(/\s*(\([^()]*\)|\[[^[\]]*\])\s*$/, "");
  return s.trim() || description.trim();
}

// ------------------------------------------------------------------- plan

export interface RenameRow {
  id: number;
  file: string;
  current: string;
  proposed: string;
  description: string;
  year: string;
  manufacturer: string;
  clone: boolean;
}

interface RawRom {
  id: number;
  name: string | null;
  fs_name: string;
  fs_name_no_ext?: string;
}

/** Every game of a platform (ids, names, file names), paging through the API. */
async function platformRoms(platformId: number, onProgress?: (done: number, total: number) => void): Promise<RawRom[]> {
  const out: RawRom[] = [];
  const limit = 500;
  for (let offset = 0; ; offset += limit) {
    const q = new URLSearchParams({ platform_ids: String(platformId), platform_id: String(platformId), limit: String(limit), offset: String(offset), order_by: "name", order_dir: "asc" });
    const body = await apiGet<{ items?: RawRom[]; total?: number } | RawRom[]>(`/api/roms?${q}`, 120_000);
    const items = Array.isArray(body) ? body : (body.items ?? []);
    const total = Array.isArray(body) ? items.length : (body.total ?? items.length);
    out.push(...items);
    onProgress?.(out.length, total);
    if (items.length < limit || out.length >= total) break;
  }
  return out;
}

const shortName = (rom: RawRom) => (rom.fs_name_no_ext || basename(rom.fs_name, extname(rom.fs_name))).trim().toLowerCase();

/** Groups of MAME tags that can be appended to names, e.g. "(Parent) (Working)". */
export type TagGroup = "kind" | "mechanical" | "status";

/** The tags for a set, in a fixed order: kind, mechanical, emulation status. */
export function tagsFor(e: MameEntry, groups: TagGroup[]): string[] {
  const out: string[] = [];
  if (groups.includes("kind")) {
    if (e.isbios) out.push("BIOS");
    else if (e.isdevice || !e.runnable) out.push("Device");
    else out.push(e.cloneof ? "Clone" : "Parent");
  }
  if (groups.includes("mechanical") && e.ismechanical) out.push("Mechanical");
  if (groups.includes("status")) {
    if (e.driverStatus === "good") out.push("Working");
    else if (e.driverStatus === "imperfect") out.push("Imperfect");
    else if (e.driverStatus === "preliminary") out.push("Not Working");
  }
  return out;
}

export interface PlanResult {
  rows: RenameRow[];
  games: number;
  matched: number;
  unchanged: number;
  machinesInFile: number;
  features: FileFeatures;
}

export async function buildPlan(
  platformId: number,
  xmlPath: string,
  options: { clean: boolean; tags?: TagGroup[] },
  progress: (label: string, fraction: number) => void,
): Promise<PlanResult> {
  progress("Reading games from RomM…", 0);
  const roms = await platformRoms(platformId, (done, total) => progress(`Reading games from RomM… ${done}/${total}`, total ? done / total : 0));
  const wanted = new Set(roms.map(shortName));
  progress("Reading MAME file…", 0);
  const { entries, machines, features } = await readMameXml(xmlPath, wanted, (f) => progress(`Reading MAME file… ${Math.round(f * 100)}%`, f));

  const found = roms
    .map((rom) => ({ rom, entry: entries.get(shortName(rom)) }))
    .filter((x): x is { rom: RawRom; entry: MameEntry } => !!x.entry?.description);

  // Shortened names must still tell sets apart: when several sets on the platform
  // shorten to the same title, only the parent set (no cloneof) gets the short
  // name; clones and look-alikes keep their full description.
  // e.g. dynamcop → "Dynamite Cop", its clone → "Dynamite Cop (Export, Model 2B)".
  const shortKey = (e: MameEntry) => cleanTitle(e.description).toLowerCase();
  const groups = new Map<string, Array<{ rom: RawRom; entry: MameEntry }>>();
  if (options.clean) for (const x of found) groups.set(shortKey(x.entry), [...(groups.get(shortKey(x.entry)) ?? []), x]);
  const baseName = (x: { rom: RawRom; entry: MameEntry }) => {
    const full = x.entry.description.trim();
    if (!options.clean) return full;
    const group = groups.get(shortKey(x.entry))!;
    if (group.length === 1) return cleanTitle(full);
    const parents = group.filter((g) => !g.entry.cloneof);
    return parents.length === 1 && parents[0] === x ? cleanTitle(full) : full;
  };
  const nameFor = (x: { rom: RawRom; entry: MameEntry }) => {
    const tags = tagsFor(x.entry, options.tags ?? []);
    return [baseName(x), ...tags.map((t) => `(${t})`)].join(" ");
  };

  const rows: RenameRow[] = [];
  let unchanged = 0;
  for (const x of found) {
    const { rom, entry } = x;
    const proposed = nameFor(x);
    const current = (rom.name ?? "").trim();
    if (proposed === current) {
      unchanged++;
      continue;
    }
    rows.push({
      id: rom.id,
      file: rom.fs_name,
      current,
      proposed,
      description: entry.description,
      year: entry.year,
      manufacturer: entry.manufacturer,
      clone: !!entry.cloneof,
    });
  }
  rows.sort((a, b) => a.file.localeCompare(b.file));
  return { rows, games: roms.length, matched: found.length, unchanged, machinesInFile: machines, features };
}

// ------------------------------------------------------------------ apply

const undoFile = () => join(app.getPath("userData"), "mame-rename-undo.json");

interface UndoRecord {
  at: string;
  server: string;
  renames: Array<{ id: number; from: string; to: string }>;
}

/** Set a game's name on the server; only the `name` field is sent, so nothing else changes. */
async function setName(id: number, name: string): Promise<void> {
  const boundary = "----romm" + Math.random().toString(16).slice(2);
  const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n--${boundary}--\r\n`, "utf8");
  const response = await apiFetch(`/api/roms/${id}`, {
    method: "PUT",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`);
  }
}

export async function applyRenames(
  serverUrl: string,
  rows: Array<{ id: number; current: string; proposed: string }>,
  progress: (label: string, fraction: number) => void,
): Promise<{ renamed: number; failed: Array<{ id: number; error: string }> }> {
  // The undo record is written before anything changes, then kept up to date.
  const record: UndoRecord = { at: new Date().toISOString(), server: serverUrl, renames: [] };
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(undoFile(), JSON.stringify(record, null, 1));
  const failed: Array<{ id: number; error: string }> = [];
  for (const [i, row] of rows.entries()) {
    progress(`Renaming ${i + 1}/${rows.length}: ${row.proposed}`, i / rows.length);
    try {
      await setName(row.id, row.proposed);
      record.renames.push({ id: row.id, from: row.current, to: row.proposed });
      if (record.renames.length % 25 === 0) await writeFile(undoFile(), JSON.stringify(record, null, 1));
    } catch (error) {
      failed.push({ id: row.id, error: (error as Error).message });
      // A permission or auth problem will fail every row: stop instead of hammering the server.
      if (/HTTP 40[13]/.test((error as Error).message)) break;
    }
  }
  await writeFile(undoFile(), JSON.stringify(record, null, 1));
  progress("Done", 1);
  return { renamed: record.renames.length, failed };
}

export async function undoInfo(): Promise<{ at: string; count: number; server: string } | null> {
  if (!existsSync(undoFile())) return null;
  try {
    const record = JSON.parse(await readFile(undoFile(), "utf8")) as UndoRecord;
    return record.renames.length ? { at: record.at, count: record.renames.length, server: record.server } : null;
  } catch {
    return null;
  }
}

/** Put back the names changed by the last rename run. */
export async function undoLast(serverUrl: string, progress: (label: string, fraction: number) => void): Promise<{ restored: number; failed: number }> {
  const record = JSON.parse(await readFile(undoFile(), "utf8")) as UndoRecord;
  if (record.server !== serverUrl) throw new Error(`The last rename was made on ${record.server}, not on the server configured now.`);
  let restored = 0;
  let failed = 0;
  const left: UndoRecord["renames"] = [];
  for (const [i, r] of record.renames.entries()) {
    progress(`Restoring ${i + 1}/${record.renames.length}: ${r.from}`, i / record.renames.length);
    try {
      await setName(r.id, r.from);
      restored++;
    } catch {
      failed++;
      left.push(r);
    }
  }
  await writeFile(undoFile(), JSON.stringify({ ...record, renames: left }, null, 1));
  progress("Done", 1);
  return { restored, failed };
}
