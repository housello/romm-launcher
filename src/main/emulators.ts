// Emulator presets, RetroArch detection and argument templating.

import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { EmulatorDef } from "./config";
import { baseDir, dataDir } from "./paths";

/** Where the launcher downloads an emulator from (see emulatorManager.ts). */
export type EmulatorSource =
  /**
   * The latest GitHub release's asset matching `asset` (a regular expression). With
   * `prerelease`, the newest release of all, pre-releases included (nightly/preview builds).
   */
  | { kind: "github"; repo: string; asset: string; prerelease?: boolean }
  /** The same on a Forgejo/Gitea server. */
  | { kind: "forgejo"; base: string; repo: string; asset: string }
  /** Dolphin's own update feed: "beta" releases, or "dev" for every development build. */
  | { kind: "dolphin"; track?: "beta" | "dev" }
  /** RetroArch from the libretro buildbot: the newest stable, or the nightly build. */
  | { kind: "retroarch"; nightly?: boolean };

export interface Preset {
  key: string;
  name: string;
  /** Executable file name, as a regular expression when it changes between builds. */
  exe: string;
  args: string;
  extractZip: boolean;
  saveMode?: "off" | "retroarch" | "custom";
  savePattern?: string;
  statePattern?: string;
  /** RomM platform slugs this emulator is usually used for. */
  platforms: string[];
  website?: string;
  /** Downloadable by the launcher. */
  source?: EmulatorSource;
  /**
   * For a nightly/preview build: the stable entry's key and the channel's name. It is a
   * separate emulator, installed in its own folder next to the stable one.
   */
  base?: string;
  channel?: string;
  /** The download is the executable itself, not an archive. */
  single?: boolean;
  /** Created next to the executable so the emulator keeps its settings in its own folder. */
  portable?: { file?: string; dir?: string };
  /**
   * Folders holding its saves, for WebDAV sync. `paths` are tried in order (relative
   * to the executable's folder, or %ENV%-prefixed), the first that exists wins;
   * `on` marks the ones synced by default.
   */
  saveFolders?: Array<{ name: string; paths: string[]; on: boolean }>;
}

const docs = (app: string, sub: string) => `%USERPROFILE%\\Documents\\${app}\\${sub}`;
const sf = (name: string, paths: string[], on = true) => ({ name, paths, on });

/** Where each emulator keeps saves: portable layout first, then its usual installed location. */
const SAVE_FOLDERS: Record<string, Preset["saveFolders"]> = {
  retroarch: [sf("saves", ["saves"]), sf("states", ["states"])],
  dolphin: [
    sf("GC", ["User\\GC", docs("Dolphin Emulator", "GC"), "%APPDATA%\\Dolphin Emulator\\GC"]),
    sf("Wii-title", ["User\\Wii\\title", docs("Dolphin Emulator", "Wii\\title"), "%APPDATA%\\Dolphin Emulator\\Wii\\title"]),
    sf("StateSaves", ["User\\StateSaves", docs("Dolphin Emulator", "StateSaves")], false),
  ],
  pcsx2: [sf("memcards", ["memcards", docs("PCSX2", "memcards")]), sf("sstates", ["sstates", docs("PCSX2", "sstates")], false)],
  duckstation: [sf("memcards", ["memcards", docs("DuckStation", "memcards")]), sf("savestates", ["savestates", docs("DuckStation", "savestates")])],
  ppsspp: [
    sf("SAVEDATA", ["memstick\\PSP\\SAVEDATA", docs("PPSSPP", "PSP\\SAVEDATA")]),
    sf("PPSSPP_STATE", ["memstick\\PSP\\PPSSPP_STATE", docs("PPSSPP", "PSP\\PPSSPP_STATE")]),
  ],
  rpcs3: [sf("savedata", ["dev_hdd0\\home\\00000001\\savedata"])],
  shadps4: [sf("savedata", ["user\\savedata", "%APPDATA%\\shadPS4\\savedata"])],
  vita3k: [sf("savedata", ["ux0\\user\\00\\savedata", "%APPDATA%\\Vita3K\\Vita3K\\ux0\\user\\00\\savedata"])],
  cemu: [sf("save", ["portable\\mlc01\\usr\\save", "mlc01\\usr\\save", "%APPDATA%\\Cemu\\mlc01\\usr\\save"])],
  ryujinx: [sf("save", ["portable\\bis\\user\\save", "%APPDATA%\\Ryujinx\\bis\\user\\save"])],
  azahar: [
    sf("sdmc", ["user\\sdmc\\Nintendo 3DS", "%APPDATA%\\Azahar\\sdmc\\Nintendo 3DS"]),
    sf("states", ["user\\states", "%APPDATA%\\Azahar\\states"]),
  ],
  snes9x: [sf("Saves", ["Saves"])],
  mesen: [sf("Saves", ["Saves", docs("Mesen2", "Saves")]), sf("SaveStates", ["SaveStates", docs("Mesen2", "SaveStates")])],
  flycast: [sf("data", ["data", "%APPDATA%\\flycast\\data"])],
  xenia: [sf("content", ["content", docs("Xenia", "content")])],
  mame: [sf("nvram", ["nvram"]), sf("cfg", ["cfg"]), sf("sta", ["sta"])],
  supermodel: [sf("NVRAM", ["NVRAM"]), sf("Saves", ["Saves"])],
  fbneo: [sf("savestates", ["savestates"])],
  openmsx: [sf("persistent", [docs("openMSX", "persistent")])],
};

const gh = (repo: string, asset: string): EmulatorSource => ({ kind: "github", repo, asset });

export const PRESETS: Preset[] = [
  {
    key: "retroarch", name: "RetroArch", exe: "retroarch.exe",
    args: '-L "{emuDir}\\cores\\{core}_libretro.dll" "{rom}"', extractZip: false, saveMode: "retroarch",
    platforms: ["nes", "snes", "n64", "gb", "gbc", "gba", "genesis", "sms", "gamegear", "segacd", "sega32", "psx", "pce", "tg16", "neogeo", "arcade", "atari2600", "atari7800", "lynx", "ngp", "ngpc", "wonderswan", "wonderswan-color", "virtualboy", "dos", "msx", "c64", "amiga", "saturn", "dc", "nds", "3do", "jaguar"],
    website: "https://www.retroarch.com", source: { kind: "retroarch" },
  },
  { key: "dolphin", name: "Dolphin", exe: "Dolphin.exe", args: '-b -e "{rom}"', extractZip: true, platforms: ["ngc", "wii"],
    website: "https://dolphin-emu.org", source: { kind: "dolphin" }, portable: { file: "portable.txt" } },
  { key: "pcsx2", name: "PCSX2", exe: "pcsx2-qt.exe", args: '-batch -fullscreen -- "{rom}"', extractZip: true, platforms: ["ps2"],
    website: "https://pcsx2.net", source: gh("PCSX2/pcsx2", "windows-x64-Qt\\.7z$"), portable: { file: "portable.txt" } },
  { key: "duckstation", name: "DuckStation", exe: "duckstation-qt-x64-ReleaseLTCG\\.exe", args: '-batch -fullscreen -- "{rom}"', extractZip: true, platforms: ["psx"],
    website: "https://www.duckstation.org", source: gh("stenzek/duckstation", "^duckstation-windows-x64-release\\.zip$"), portable: { file: "portable.txt" } },
  { key: "ppsspp", name: "PPSSPP", exe: "PPSSPPWindows64.exe", args: '"{rom}"', extractZip: false, platforms: ["psp"],
    website: "https://www.ppsspp.org", source: gh("hrydgard/ppsspp", "Windows-x64\\.zip$") },
  { key: "rpcs3", name: "RPCS3", exe: "rpcs3.exe", args: '--no-gui "{rom}"', extractZip: true, platforms: ["ps3"],
    website: "https://rpcs3.net", source: gh("RPCS3/rpcs3-binaries-win", "win64.*\\.7z$") },
  { key: "shadps4", name: "shadPS4", exe: "shadPS4\\.exe", args: '-g "{rom}"', extractZip: true, platforms: ["ps4"],
    website: "https://shadps4.net", source: gh("shadps4-emu/shadPS4", "win64-sdl.*\\.zip$") },
  { key: "vita3k", name: "Vita3K", exe: "Vita3K.exe", args: '"{rom}"', extractZip: false, platforms: ["psvita"],
    website: "https://vita3k.org", source: gh("Vita3K/Vita3K", "^windows-latest\\.zip$") },
  { key: "cemu", name: "Cemu", exe: "Cemu.exe", args: '-f -g "{rom}"', extractZip: true, platforms: ["wiiu"],
    website: "https://cemu.info", source: gh("cemu-project/Cemu", "windows-x64\\.zip$"), portable: { dir: "portable" } },
  { key: "ryujinx", name: "Ryujinx / Ryubing", exe: "Ryujinx.exe", args: '"{rom}"', extractZip: true, platforms: ["switch"],
    website: "https://ryujinx.app", source: { kind: "forgejo", base: "https://git.ryujinx.app", repo: "projects/Ryubing", asset: "win_x64\\.zip$" }, portable: { dir: "portable" } },
  { key: "azahar", name: "Azahar / Citra", exe: "azahar.exe", args: '"{rom}"', extractZip: true, platforms: ["3ds", "n3ds"],
    website: "https://azahar-emu.org", source: gh("azahar-emu/azahar", "^azahar-windows-msvc-[\\d.]+\\.zip$"), portable: { dir: "user" } },
  { key: "melonds", name: "melonDS", exe: "melonDS.exe", args: '"{rom}"', extractZip: false, saveMode: "custom", savePattern: "{romDir}/{romName}.sav", statePattern: "{romDir}/{romName}.ml*", platforms: ["nds"],
    website: "https://melonds.kuribo64.net", source: gh("melonDS-emu/melonDS", "windows-x86_64\\.zip$") },
  { key: "desmume", name: "DeSmuME", exe: "DeSmuME.*x64\\.exe", args: '"{rom}"', extractZip: false, platforms: ["nds"],
    website: "https://desmume.org", source: gh("TASEmulators/desmume", "win64\\.zip$") },
  { key: "mgba", name: "mGBA", exe: "mGBA.exe", args: '-f "{rom}"', extractZip: false, saveMode: "custom", savePattern: "{romDir}/{romName}.sav", statePattern: "{romDir}/{romName}.ss*", platforms: ["gba", "gb", "gbc"],
    website: "https://mgba.io", source: gh("mgba-emu/mgba", "win64\\.7z$") },
  { key: "sameboy", name: "SameBoy", exe: "sameboy\\.exe", args: '"{rom}"', extractZip: false, platforms: ["gb", "gbc"],
    website: "https://sameboy.github.io", source: gh("LIJI32/SameBoy", "winsdl.*\\.zip$") },
  { key: "skyemu", name: "SkyEmu", exe: "SkyEmu.*\\.exe", args: '"{rom}"', extractZip: false, platforms: ["gb", "gbc", "gba", "nds"],
    website: "https://github.com/skylersaleh/SkyEmu", source: gh("skylersaleh/SkyEmu", "Windows\\.exe$"), single: true },
  { key: "gearboy", name: "Gearboy", exe: "Gearboy.exe", args: '"{rom}"', extractZip: false, platforms: ["gb", "gbc"],
    website: "https://github.com/drhelius/Gearboy", source: gh("drhelius/Gearboy", "desktop-windows-x64\\.zip$") },
  { key: "gopher64", name: "gopher64", exe: "gopher64.*\\.exe", args: '"{rom}"', extractZip: true, platforms: ["n64"],
    website: "https://github.com/gopher64/gopher64", source: gh("gopher64/gopher64", "windows-x86_64\\.exe$"), single: true },
  { key: "snes9x", name: "Snes9x", exe: "snes9x-x64\\.exe", args: '"{rom}"', extractZip: false, platforms: ["snes"],
    website: "https://www.snes9x.com", source: gh("snes9xgit/snes9x", "win32-x64\\.zip$") },
  { key: "bsnes", name: "bsnes", exe: "bsnes\\.exe", args: '"{rom}" --fullscreen', extractZip: false, platforms: ["snes"],
    website: "https://github.com/bsnes-emu/bsnes", source: gh("bsnes-emu/bsnes", "windows\\.zip$") },
  { key: "mesen", name: "Mesen", exe: "Mesen\\.exe", args: '"{rom}" --fullscreen', extractZip: false, platforms: ["nes", "famicom", "fds", "snes", "gb", "gbc", "gba", "pce", "tg16", "sms", "gamegear", "wonderswan", "wonderswan-color"],
    website: "https://www.mesen.ca", source: gh("SourMesen/Mesen2", "_Windows\\.zip$") },
  { key: "ares", name: "ares", exe: "ares\\.exe", args: '"{rom}" --fullscreen', extractZip: false, platforms: ["nes", "snes", "n64", "64dd", "gb", "gbc", "gba", "genesis", "sms", "gamegear", "segacd", "sega32", "pce", "tg16", "neogeo", "ngp", "ngpc", "wonderswan", "wonderswan-color", "colecovision", "msx", "psx"],
    website: "https://ares-emu.net", source: gh("ares-emulator/ares", "windows-x64\\.zip$") },
  { key: "bizhawk", name: "BizHawk", exe: "EmuHawk\\.exe", args: '"{rom}"', extractZip: false, platforms: ["nes", "snes", "n64", "gb", "gbc", "gba", "genesis", "sms", "gamegear", "psx", "saturn", "pce", "atari2600", "atari7800", "lynx", "ngp", "ngpc", "wonderswan", "virtualboy", "colecovision", "intellivision", "nds"],
    website: "https://tasvideos.org/BizHawk", source: gh("TASEmulators/BizHawk", "win-x64\\.zip$") },
  { key: "gearsystem", name: "Gearsystem", exe: "Gearsystem\\.exe", args: '"{rom}"', extractZip: false, platforms: ["sms", "gamegear", "sg1000"],
    website: "https://github.com/drhelius/Gearsystem", source: gh("drhelius/Gearsystem", "desktop-windows-x64\\.zip$") },
  { key: "geargrafx", name: "Geargrafx", exe: "Geargrafx\\.exe", args: '"{rom}"', extractZip: false, platforms: ["pce", "tg16", "supergrafx", "turbografx-cd"],
    website: "https://github.com/drhelius/Geargrafx", source: gh("drhelius/Geargrafx", "desktop-windows-x64\\.zip$") },
  { key: "stella", name: "Stella", exe: "Stella\\.exe", args: '"{rom}"', extractZip: false, platforms: ["atari2600"],
    website: "https://stella-emu.github.io", source: gh("stella-emu/stella", "windows\\.zip$") },
  { key: "openmsx", name: "openMSX", exe: "openmsx\\.exe", args: '-cart "{rom}"', extractZip: false, platforms: ["msx", "msx2"],
    website: "https://openmsx.org", source: gh("openMSX/openMSX", "windows-vc-x64-bin\\.zip$") },
  { key: "flycast", name: "Flycast", exe: "flycast.exe", args: '"{rom}"', extractZip: false, platforms: ["dc", "naomi", "atomiswave"],
    website: "https://github.com/flyinghead/flycast", source: gh("flyinghead/flycast", "win64.*\\.zip$") },
  { key: "xemu", name: "xemu", exe: "xemu.exe", args: '-full-screen -dvd_path "{rom}"', extractZip: true, platforms: ["xbox"],
    website: "https://xemu.app", source: gh("xemu-project/xemu", "^xemu-[\\d.]+-windows-x86_64\\.zip$") },
  { key: "xenia", name: "Xenia", exe: "xenia_canary.exe", args: '"{rom}"', extractZip: true, platforms: ["xbox360"],
    website: "https://xenia.jp", source: gh("xenia-canary/xenia-canary-releases", "windows.*\\.zip$"), portable: { file: "portable.txt" } },
  { key: "mame", name: "MAME", exe: "mame.exe", args: '{romName} -rompath "{romDir}"', extractZip: false, platforms: ["arcade", "mame"],
    website: "https://www.mamedev.org", source: gh("mamedev/mame", "b_x64\\.exe$") },
  { key: "supermodel", name: "Supermodel", exe: "supermodel\\.exe", args: '"{rom}" -fullscreen', extractZip: false, platforms: ["model3"],
    website: "https://www.supermodel3.com", source: gh("trzy/Supermodel", "windows\\.zip$") },
  { key: "fbneo", name: "FinalBurn Neo", exe: "fbneo64\\.exe", args: "{romName}", extractZip: false, platforms: ["arcade", "fbneo", "neogeo", "neogeoaes", "neogeomvs"],
    website: "https://neo-source.com", source: gh("finalburnneo/FBNeo", "^windows-x86_64\\.zip$") },
  { key: "dosbox", name: "DOSBox Staging", exe: "dosbox\\.exe", args: '"{rom}" -exit', extractZip: true, platforms: ["dos"],
    website: "https://www.dosbox-staging.org", source: gh("dosbox-staging/dosbox-staging", "windows-x64-v[\\d.]+\\.zip$") },
  { key: "dosbox-x", name: "DOSBox-X", exe: "dosbox-x\\.exe", args: '"{rom}" -exit', extractZip: true, platforms: ["dos", "win3x", "pc-98"],
    website: "https://dosbox-x.com", source: gh("joncampbell123/dosbox-x", "vsbuild-win64-.*-portable\\.zip$") },
  { key: "custom", name: "Custom", exe: "", args: '"{rom}"', extractZip: false, platforms: [] },
];

/**
 * Nightly and preview builds, checked against each project's releases: only those that
 * publish Windows builds newer than their stable release. Each becomes its own catalog
 * entry right after the stable one.
 */
const NIGHTLIES: Array<{ base: string; channel: string; source: EmulatorSource; website?: string }> = [
  { base: "retroarch", channel: "Nightly", source: { kind: "retroarch", nightly: true } },
  { base: "dolphin", channel: "Development", source: { kind: "dolphin", track: "dev" } },
  { base: "pcsx2", channel: "Nightly", source: { kind: "github", repo: "PCSX2/pcsx2", asset: "windows-x64-Qt\\.7z$", prerelease: true } },
  { base: "duckstation", channel: "Preview", source: { kind: "github", repo: "stenzek/duckstation", asset: "^duckstation-windows-x64-release\\.zip$", prerelease: true } },
  { base: "shadps4", channel: "Nightly", source: { kind: "github", repo: "shadps4-emu/shadPS4", asset: "win64-sdl.*\\.zip$", prerelease: true } },
  { base: "ryujinx", channel: "Canary", source: { kind: "forgejo", base: "https://git.ryujinx.app", repo: "Ryubing/Canary", asset: "win_x64\\.zip$" } },
  { base: "azahar", channel: "Pre-release", source: { kind: "github", repo: "azahar-emu/azahar", asset: "^azahar-windows-msvc-[\\d.]+(-rc\\d+)?\\.zip$", prerelease: true } },
  { base: "bsnes", channel: "Nightly", source: { kind: "github", repo: "bsnes-emu/bsnes", asset: "windows\\.zip$", prerelease: true } },
  { base: "xemu", channel: "Nightly", source: { kind: "github", repo: "xemu-project/xemu", asset: "^xemu-[\\d.]+-\\d+-g[0-9a-f]+-windows-x86_64\\.zip$", prerelease: true } },
];
for (const n of NIGHTLIES) {
  const at = PRESETS.findIndex((p) => p.key === n.base);
  const stable = PRESETS[at]!;
  PRESETS.splice(at + 1, 0, { ...stable, key: `${n.base}-${n.channel.toLowerCase()}`, name: `${stable.name} (${n.channel})`, base: n.base, channel: n.channel, source: n.source, website: n.website ?? stable.website });
}

for (const preset of PRESETS) preset.saveFolders = SAVE_FOLDERS[preset.base ?? preset.key];

/** RetroArch, stable or nightly: libretro cores, and the {core} placeholder's default cores. */
export const isRetroArchKey = (key: string | undefined) => key === "retroarch" || PRESETS.some((p) => p.key === key && p.base === "retroarch");

/** Suggested libretro core per RomM platform slug. */
export const DEFAULT_CORES: Record<string, string> = {
  nes: "mesen", famicom: "mesen", fds: "mesen", snes: "snes9x", sfam: "snes9x", n64: "mupen64plus_next",
  gb: "gambatte", gbc: "gambatte", gba: "mgba", nds: "melonds", virtualboy: "mednafen_vb",
  genesis: "genesis_plus_gx", "genesis-slash-megadrive": "genesis_plus_gx", sms: "genesis_plus_gx",
  gamegear: "genesis_plus_gx", segacd: "genesis_plus_gx", sega32: "picodrive", saturn: "mednafen_saturn",
  dc: "flycast", psx: "swanstation", psp: "ppsspp", pce: "mednafen_pce", tg16: "mednafen_pce",
  "turbografx-cd": "mednafen_pce", neogeo: "fbneo", arcade: "fbneo", mame: "mame", atari2600: "stella",
  atari7800: "prosystem", lynx: "handy", jaguar: "virtualjaguar", ngp: "mednafen_ngp", ngpc: "mednafen_ngp",
  wonderswan: "mednafen_wswan", "wonderswan-color": "mednafen_wswan", dos: "dosbox_pure", msx: "bluemsx",
  c64: "vice_x64", amiga: "puae", "3do": "opera", colecovision: "bluemsx", intellivision: "freeintv",
};

const RETROARCH_CANDIDATES = (): string[] => {
  const env = process.env;
  const roots = [
    "C:\\RetroArch-Win64",
    "C:\\RetroArch",
    env.APPDATA && join(env.APPDATA, "RetroArch"),
    env.ProgramFiles && join(env.ProgramFiles, "RetroArch"),
    env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"]!, "Steam", "steamapps", "common", "RetroArch"),
    env.ProgramFiles && join(env.ProgramFiles, "Steam", "steamapps", "common", "RetroArch"),
    env.USERPROFILE && join(env.USERPROFILE, "scoop", "apps", "retroarch", "current"),
    "C:\\RetroBat\\emulators\\retroarch",
    "C:\\Emulators\\RetroArch",
  ].filter((p): p is string => typeof p === "string");
  return roots.map((root) => join(root, "retroarch.exe"));
};

export function detectRetroArch(): string | null {
  return RETROARCH_CANDIDATES().find((candidate) => existsSync(candidate)) ?? null;
}

/** Libretro cores installed next to an emulator executable (RetroArch). */
export function listCores(emulatorPath: string): string[] {
  const dir = join(dirname(emulatorPath), "cores");
  try {
    return readdirSync(dir)
      .filter((name) => /_libretro\.(dll|so|dylib)$/i.test(name))
      .map((name) => name.replace(/_libretro\.(dll|so|dylib)$/i, ""))
      .sort();
  } catch {
    return [];
  }
}

/** Split an argument template the way a Windows shell would, honouring quotes. */
export function tokenize(template: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (const ch of template) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
    } else if (/\s/.test(ch) && !quoted) {
      if (started) tokens.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) tokens.push(current);
  return tokens;
}

export interface LaunchVars {
  rom: string;
  core?: string;
  /** RomM platform slug and name of the game. */
  slug?: string;
  platform?: string;
  /** The game's name in RomM, and its RomM id. */
  game?: string;
  romId?: number;
  /** The collection the game was started from, if it was. */
  collection?: string;
  /** The launcher's save folder for the game (RomM save sync). */
  saveDir?: string;
}

/** "Street Fighter II: Turbo" → "street-fighter-ii-turbo", safe in a path. */
export function slugify(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Every placeholder's value for a launch (see PLACEHOLDERS in the renderer for the list
 * shown to the user). Unknown values are empty strings, so a template never keeps "{slug}".
 */
export function placeholderValues(emulator: EmulatorDef, vars: LaunchVars): Record<string, string> {
  const ext = extname(vars.rom);
  return {
    rom: vars.rom,
    romDir: dirname(vars.rom),
    romFile: basename(vars.rom),
    romName: basename(vars.rom, ext),
    romExt: ext.replace(/^\./, ""),
    emuDir: dirname(emulator.path),
    emuExe: emulator.path,
    core: vars.core ?? "",
    slug: vars.slug ?? "",
    platform: vars.platform ?? "",
    game: vars.game ?? "",
    romId: vars.romId !== undefined ? String(vars.romId) : "",
    collection: vars.collection ?? "",
    collectionSlug: vars.collection ? slugify(vars.collection) : "",
    saveDir: vars.saveDir ?? "",
    launcherDir: baseDir(),
    "romm-launcherdir": baseDir(),
    dataDir: dataDir(),
  };
}

/** Replace {name} placeholders; names may contain letters, digits, "_" and "-". */
export function expandPlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(/\{([\w-]+)\}/g, (match, key: string) => (key in values ? values[key]! : match));
}

/** Build argv for spawn(). Substitution happens per token, so spaces in paths are safe. */
export function buildArgs(emulator: EmulatorDef, template: string, vars: LaunchVars): string[] {
  const values = placeholderValues(emulator, vars);
  return tokenize(template).map((token) => expandPlaceholders(token, values));
}

/** Save mode of an emulator, inferring it for configs written before save sync existed. */
export function saveModeOf(emulator: EmulatorDef): "off" | "retroarch" | "custom" {
  if (emulator.saveMode) return emulator.saveMode;
  return /retroarch/i.test(basename(emulator.path)) ? "retroarch" : "off";
}
