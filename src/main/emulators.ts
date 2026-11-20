// Emulator presets, RetroArch detection and argument templating.

import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { EmulatorDef } from "./config";

/** Where the launcher downloads an emulator from (see emulatorManager.ts). */
export type EmulatorSource =
  /** The latest GitHub release's asset matching `asset` (a regular expression). */
  | { kind: "github"; repo: string; asset: string }
  /** The same on a Forgejo/Gitea server. */
  | { kind: "forgejo"; base: string; repo: string; asset: string }
  /** Dolphin's own update feed. */
  | { kind: "dolphin" }
  /** The newest stable RetroArch on the libretro buildbot. */
  | { kind: "retroarch" };

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
  /** The download is the executable itself, not an archive. */
  single?: boolean;
  /** Created next to the executable so the emulator keeps its settings in its own folder. */
  portable?: { file?: string; dir?: string };
}

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
  { key: "fbneo", name: "FinalBurn Neo", exe: "fbneo64\\.exe", args: "{romName}", extractZip: false, platforms: ["arcade", "fbneo", "neogeo", "neogeoaes", "neogeomvs"],
    website: "https://neo-source.com", source: gh("finalburnneo/FBNeo", "^windows-x86_64\\.zip$") },
  { key: "dosbox", name: "DOSBox Staging", exe: "dosbox\\.exe", args: '"{rom}" -exit', extractZip: true, platforms: ["dos"],
    website: "https://www.dosbox-staging.org", source: gh("dosbox-staging/dosbox-staging", "windows-x64-v[\\d.]+\\.zip$") },
  { key: "dosbox-x", name: "DOSBox-X", exe: "dosbox-x\\.exe", args: '"{rom}" -exit', extractZip: true, platforms: ["dos", "win3x", "pc-98"],
    website: "https://dosbox-x.com", source: gh("joncampbell123/dosbox-x", "vsbuild-win64-.*-portable\\.zip$") },
  { key: "custom", name: "Custom", exe: "", args: '"{rom}"', extractZip: false, platforms: [] },
];

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
}

/** Build argv for spawn(). Substitution happens per token, so spaces in paths are safe. */
export function buildArgs(emulator: EmulatorDef, template: string, vars: LaunchVars): string[] {
  const values: Record<string, string> = {
    rom: vars.rom,
    romDir: dirname(vars.rom),
    romFile: basename(vars.rom),
    romName: basename(vars.rom, extname(vars.rom)),
    emuDir: dirname(emulator.path),
    core: vars.core ?? "",
  };
  return tokenize(template).map((token) => token.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match));
}

/** Save mode of an emulator, inferring it for configs written before save sync existed. */
export function saveModeOf(emulator: EmulatorDef): "off" | "retroarch" | "custom" {
  if (emulator.saveMode) return emulator.saveMode;
  return /retroarch/i.test(basename(emulator.path)) ? "retroarch" : "off";
}
