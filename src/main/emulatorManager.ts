// Emulators the launcher downloads, installs and updates from its catalog (PRESETS
// entries with a `source`). Each goes in its own folder under the emulator folder
// (default "emulators" next to the exe). An update unpacks over the old files, so
// settings and saves the emulator keeps in its folder stay.
//
// Archives (zip, 7z, 7-Zip self-extracting exe) are unpacked with Windows' own
// tar.exe (libarchive), so no extractor ships with the launcher.

import { net } from "electron";
import { execFile } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { loadConfig, updateConfig, type EmulatorDef } from "./config";
import { DEFAULT_CORES, PRESETS, type EmulatorSource, type Preset } from "./emulators";
import { dataDir, resolvePath, toStored } from "./paths";

const run = promisify(execFile);
const TAR = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
const UA = { "User-Agent": "RomM-Launcher" };
const CORE_URL = (core: string) => `https://buildbot.libretro.com/nightly/windows/x86_64/latest/${core}_libretro.dll.zip`;

export interface Release {
  version: string;
  assetKey: string;
  url: string;
  fileName: string;
  size: number;
}

export type Progress = (event: { key: string; label: string; received: number; total: number }) => void;

export class ManagerError extends Error {}

function presetOf(key: string): Preset & { source: EmulatorSource } {
  const preset = PRESETS.find((p) => p.key === key);
  if (!preset?.source) throw new ManagerError(`${key} cannot be downloaded by the launcher.`);
  return preset as Preset & { source: EmulatorSource };
}

async function getJson<T>(url: string): Promise<T> {
  const response = await net.fetch(url, { headers: { Accept: "application/json", ...UA } });
  if (response.status === 403 && url.includes("api.github.com")) {
    throw new ManagerError("GitHub's hourly limit for anonymous requests is used up; try again later.");
  }
  if (!response.ok) throw new ManagerError(`${new URL(url).host} answered HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** A tag like "latest" or "continuous", or a commit hash, says nothing: use the build date. */
function displayVersion(tag: string, date: string | undefined): string {
  if (/^(latest|continuous|nightly)$/i.test(tag) || /^(build-)?[0-9a-f]{7,40}$/i.test(tag)) {
    return date ? date.slice(0, 10) : tag;
  }
  // mame0289 → 0.289; release_0_9_13 → 0.9.13; dosbox-x-v2026.10.01 → 2026.10.01.
  const mame = /^mame0(\d+)$/i.exec(tag);
  if (mame) return `0.${mame[1]}`;
  return tag
    .replace(/^(release[_-]|[a-z][\w-]*?-v(?=\d))/i, "")
    .replace(/^v\.?/i, "")
    .replace(/^(\d+)_(\d+)(?:_(\d+))?$/, (_m, a, b, c) => [a, b, c].filter(Boolean).join("."));
}

/** The newest release of a catalog emulator. */
export async function latestRelease(key: string): Promise<Release> {
  const { source } = presetOf(key);
  if (source.kind === "github" || source.kind === "forgejo") {
    const url = source.kind === "github"
      ? `https://api.github.com/repos/${source.repo}/releases/latest`
      : `${source.base}/api/v1/repos/${source.repo}/releases?limit=1`;
    const body = await getJson<any>(url);
    const release = Array.isArray(body) ? body[0] : body;
    const re = new RegExp(source.asset, "i");
    const asset = (release?.assets ?? []).find((a: any) => re.test(a.name));
    if (!asset) throw new ManagerError(`The latest ${key} release has no Windows download the launcher recognises.`);
    return {
      version: displayVersion(String(release.tag_name), asset.updated_at ?? release.published_at),
      assetKey: String(asset.id ?? asset.uuid ?? asset.browser_download_url) + "@" + (asset.updated_at ?? ""),
      url: asset.browser_download_url,
      fileName: asset.name,
      size: asset.size ?? 0,
    };
  }
  if (source.kind === "dolphin") {
    const feed = await getJson<{ shortrev: string; artifacts?: Array<{ system: string; url: string }> }>("https://dolphin-emu.org/update/latest/beta/");
    const artifact = feed.artifacts?.find((a) => /^windows x64/i.test(a.system));
    if (!artifact) throw new ManagerError("Dolphin's update feed has no Windows x64 build.");
    return { version: feed.shortrev, assetKey: artifact.url, url: artifact.url, fileName: basename(new URL(artifact.url).pathname), size: 0 };
  }
  // RetroArch: the highest version listed on the buildbot's stable folder.
  const response = await net.fetch("https://buildbot.libretro.com/stable/", { headers: UA });
  if (!response.ok) throw new ManagerError(`buildbot.libretro.com answered HTTP ${response.status}`);
  const versions = [...(await response.text()).matchAll(/href="\/stable\/(\d+\.\d+\.\d+)\/"/g)].map((m) => m[1]!);
  const newest = versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
  if (!newest) throw new ManagerError("No stable RetroArch found on the libretro buildbot.");
  const url = `https://buildbot.libretro.com/stable/${newest}/windows/x86_64/RetroArch.7z`;
  return { version: newest, assetKey: url, url, fileName: "RetroArch.7z", size: 0 };
}

async function download(url: string, dest: string, onProgress: (received: number, total: number) => void): Promise<void> {
  const response = await net.fetch(url, { headers: UA });
  if (!response.ok || !response.body) throw new ManagerError(`Download failed: HTTP ${response.status} (${new URL(url).host})`);
  const total = Number(response.headers.get("content-length") ?? 0);
  let received = 0;
  let last = 0;
  const source = Readable.fromWeb(response.body as never);
  source.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (Date.now() - last > 250) {
      last = Date.now();
      onProgress(received, total);
    }
  });
  await pipeline(source, createWriteStream(dest));
}

/** The folder holding an archive's files: its single top folder, if it has nothing else. */
async function contentRoot(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.length === 1 && entries[0]!.isDirectory() ? contentRoot(join(dir, entries[0]!.name)) : dir;
}

/** The executable matching `pattern` in `dir`, looking a few folders deep. */
async function findExe(dir: string, pattern: string, depth = 3): Promise<string | null> {
  const re = new RegExp(`^${pattern}$`, "i");
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const hit = entries.find((e) => e.isFile() && re.test(e.name));
  if (hit) return join(dir, hit.name);
  if (depth === 0) return null;
  for (const entry of entries.filter((e) => e.isDirectory())) {
    const found = await findExe(join(dir, entry.name), pattern, depth - 1);
    if (found) return found;
  }
  return null;
}

/** Settings files an update leaves alone when they exist (e.g. Supermodel's Config\Supermodel.ini). */
const KEEP_SETTINGS = /\.(ini|cfg|conf)$/i;

/** Folder a catalog emulator is downloaded to: <emulator folder>\<key>. */
export function installDir(key: string): string {
  return join(resolvePath(loadConfig().emulatorDir || "emulators"), key);
}

/** The emulator the launcher updates for a catalog key, if any. */
function managedEntry(key: string): EmulatorDef | undefined {
  return loadConfig().emulators.find((e) => e.managed?.key === key);
}

/** Where updates of a catalog emulator go: an adopted emulator's own folder, else installDir. */
export function managedFolder(key: string): string {
  const dir = managedEntry(key)?.managed?.dir;
  return dir ? resolvePath(dir) : installDir(key);
}

/** The catalog entry an emulator added by hand matches, by its executable's name. */
export function catalogMatch(emulator: EmulatorDef): (Preset & { source: EmulatorSource }) | undefined {
  const exe = basename(emulator.path || "");
  return PRESETS.find((p): p is Preset & { source: EmulatorSource } => !!p.source && !!p.exe && new RegExp(`^${p.exe}$`, "i").test(exe));
}

/** The version in an executable's file properties, or "" when it has none. */
async function exeVersion(path: string): Promise<string> {
  try {
    const { stdout } = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      "$v = (Get-Item -LiteralPath $env:EMU_EXE).VersionInfo; if ($v.ProductVersion) { $v.ProductVersion } else { $v.FileVersion }"],
      { windowsHide: true, timeout: 15_000, env: { ...process.env, EMU_EXE: path } });
    return stdout.trim().split(/\s/)[0] ?? "";
  } catch {
    return "";
  }
}

/**
 * Let the launcher update an emulator added by hand: updates unpack over its own
 * folder, like the ones it downloaded, so its settings and saves stay.
 */
export async function adoptEmulator(id: string): Promise<EmulatorDef> {
  const config = loadConfig();
  const emulator = config.emulators.find((e) => e.id === id);
  if (!emulator) throw new ManagerError("This emulator is no longer in the list.");
  if (emulator.managed) return emulator;
  const preset = catalogMatch(emulator);
  if (!preset) throw new ManagerError(`The launcher cannot download ${emulator.name}, so it cannot update it.`);
  const other = managedEntry(preset.key);
  if (other) throw new ManagerError(`The launcher already updates ${preset.name} (“${other.name}”). Let that one go first.`);
  const exe = resolvePath(emulator.path);
  if (!existsSync(exe)) throw new ManagerError(`${exe} does not exist.`);
  const managed = { key: preset.key, version: (await exeVersion(exe)) || "unknown", assetKey: "", installedAt: 0, dir: toStored(dirname(exe)) };
  const updated = { ...emulator, managed };
  updateConfig({ emulators: loadConfig().emulators.map((e) => (e.id === id ? updated : e)) });
  return updated;
}

/** Stop updating an emulator the launcher adopted; its files stay as they are. */
export function releaseEmulator(id: string): EmulatorDef {
  const config = loadConfig();
  const emulator = config.emulators.find((e) => e.id === id);
  if (!emulator) throw new ManagerError("This emulator is no longer in the list.");
  const { managed: _managed, ...rest } = emulator;
  updateConfig({ emulators: config.emulators.map((e) => (e.id === id ? rest : e)) });
  return rest;
}

/**
 * Download and install (or update) a catalog emulator, then add it to the
 * emulator list, mapped to its usual platforms that have no emulator yet.
 */
export async function installEmulator(key: string, libraryPlatforms: string[], onProgress: Progress): Promise<EmulatorDef> {
  const preset = presetOf(key);
  const release = await latestRelease(key);
  const work = join(dataDir(), "emulator-downloads", `${key}-${Date.now()}`);
  const adoptedDir = managedEntry(key)?.managed?.dir;
  const target = managedFolder(key);
  await mkdir(work, { recursive: true });
  try {
    const archive = join(work, release.fileName);
    await download(release.url, archive, (received, total) =>
      onProgress({ key, label: `Downloading ${preset.name} ${release.version}`, received, total: total || release.size }));
    onProgress({ key, label: `Installing ${preset.name}…`, received: 0, total: 0 });

    let root: string;
    if (preset.single) {
      root = archive;
    } else {
      const unpacked = join(work, "files");
      await mkdir(unpacked);
      try {
        await run(TAR, ["-xf", archive, "-C", unpacked], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      } catch (error) {
        throw new ManagerError(`Could not unpack ${release.fileName}: ${(error as { stderr?: string }).stderr?.trim() || (error as Error).message}`);
      }
      root = await contentRoot(unpacked);
    }

    await mkdir(target, { recursive: true });
    try {
      if (preset.single) await copyFile(root, join(target, release.fileName));
      // Settings files already there are the user's: an archive's default copy does not replace them.
      else await cp(root, target, { recursive: true, force: true, filter: (_src, dest) => !(KEEP_SETTINGS.test(dest) && existsSync(dest)) });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EBUSY") throw new ManagerError(`Close ${preset.name} first: its files are in use.`);
      if (code === "EPERM" || code === "EACCES") {
        throw new ManagerError(`Could not write to ${target}: close ${preset.name} if it is running; a folder like Program Files needs administrator rights.`);
      }
      throw error;
    }

    const exe = await findExe(target, preset.exe);
    if (!exe) throw new ManagerError(`${preset.name} was unpacked to ${target}, but its executable was not found there.`);
    if (preset.portable?.file && !existsSync(join(target, preset.portable.file))) await writeFile(join(target, preset.portable.file), "");
    if (preset.portable?.dir) await mkdir(join(target, preset.portable.dir), { recursive: true });

    const managed = { key, version: release.version, assetKey: release.assetKey, installedAt: Date.now(), ...(adoptedDir ? { dir: adoptedDir } : {}) };
    return register(preset, toStored(exe), managed, libraryPlatforms);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Add the emulator to the settings, or update the entry the launcher installed before. */
function register(preset: Preset, path: string, managed: NonNullable<EmulatorDef["managed"]>, libraryPlatforms: string[]): EmulatorDef {
  const config = loadConfig();
  const existing = config.emulators.find((e) => e.managed?.key === preset.key);
  if (existing) {
    const updated = { ...existing, path, managed };
    updateConfig({ emulators: config.emulators.map((e) => (e === existing ? updated : e)) });
    return updated;
  }
  const emulator: EmulatorDef = {
    id: `${preset.key}-${Date.now().toString(36)}`,
    name: preset.name,
    path,
    args: preset.args,
    extractZip: preset.extractZip,
    saveMode: preset.saveMode ?? "off",
    savePattern: preset.savePattern ?? "",
    statePattern: preset.statePattern ?? "",
    managed,
  };
  const platforms = { ...config.platforms };
  for (const slug of preset.platforms) {
    if (!platforms[slug] && libraryPlatforms.includes(slug)) {
      platforms[slug] = { emulatorId: emulator.id, core: preset.key === "retroarch" ? DEFAULT_CORES[slug] : undefined };
    }
  }
  updateConfig({ emulators: [...config.emulators, emulator], platforms });
  return emulator;
}

/** Newer releases of the emulators the launcher installed, keyed by catalog key. */
export async function checkEmulatorUpdates(): Promise<Record<string, { version: string } | { error: string }>> {
  const out: Record<string, { version: string } | { error: string }> = {};
  for (const emulator of loadConfig().emulators.filter((e) => e.managed)) {
    const { key, assetKey } = emulator.managed!;
    try {
      const release = await latestRelease(key);
      if (release.assetKey !== assetKey) out[key] = { version: release.version };
    } catch (error) {
      out[key] = { error: (error as Error).message };
    }
  }
  return out;
}

/** Download libretro cores into a RetroArch the launcher installed (or the one given). */
export async function installCores(cores: string[], onProgress: Progress): Promise<string[]> {
  const retroarch = loadConfig().emulators.find((e) => e.managed?.key === "retroarch")
    ?? loadConfig().emulators.find((e) => /retroarch\.exe$/i.test(e.path));
  if (!retroarch) throw new ManagerError("Install RetroArch first.");
  const coresDir = join(resolvePath(retroarch.path), "..", "cores");
  await mkdir(coresDir, { recursive: true });
  const work = join(dataDir(), "emulator-downloads", `cores-${Date.now()}`);
  await mkdir(work, { recursive: true });
  const installed: string[] = [];
  try {
    for (const [i, core] of [...new Set(cores)].entries()) {
      if (!/^[\w-]+$/.test(core)) continue;
      onProgress({ key: "retroarch", label: `Core ${core} (${i + 1}/${cores.length})`, received: i, total: cores.length });
      const archive = join(work, `${core}.zip`);
      try {
        await download(CORE_URL(core), archive, () => undefined);
        await run(TAR, ["-xf", archive, "-C", coresDir], { windowsHide: true });
        installed.push(core);
      } catch (error) {
        console.error(`[cores] ${core}`, error);
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
  return installed;
}
