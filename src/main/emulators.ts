// Emulator presets, RetroArch detection and argument templating.

import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { EmulatorDef } from "./config";

export interface Preset {
  key: string;
  name: string;
  exe: string;
  args: string;
  extractZip: boolean;
  saveMode?: "off" | "retroarch" | "custom";
  savePattern?: string;
  statePattern?: string;
  /** RomM platform slugs this emulator is usually used for. */
  platforms: string[];
}

export const PRESETS: Preset[] = [
  {
    key: "retroarch", name: "RetroArch", exe: "retroarch.exe",
    args: '-L "{emuDir}\\cores\\{core}_libretro.dll" "{rom}"', extractZip: false, saveMode: "retroarch",
    platforms: ["nes", "snes", "n64", "gb", "gbc", "gba", "genesis", "sms", "gamegear", "segacd", "sega32", "psx", "pce", "tg16", "neogeo", "arcade", "atari2600", "atari7800", "lynx", "ngp", "ngpc", "wonderswan", "wonderswan-color", "virtualboy", "dos", "msx", "c64", "amiga", "saturn", "dc", "nds", "3do", "jaguar"],
  },
  { key: "dolphin", name: "Dolphin", exe: "Dolphin.exe", args: '-b -e "{rom}"', extractZip: true, platforms: ["ngc", "wii"] },
  { key: "pcsx2", name: "PCSX2", exe: "pcsx2-qt.exe", args: '-batch -fullscreen -- "{rom}"', extractZip: true, platforms: ["ps2"] },
  { key: "duckstation", name: "DuckStation", exe: "duckstation-qt-x64-ReleaseLTCG.exe", args: '-batch -fullscreen -- "{rom}"', extractZip: true, platforms: ["psx"] },
  { key: "ppsspp", name: "PPSSPP", exe: "PPSSPPWindows64.exe", args: '"{rom}"', extractZip: false, platforms: ["psp"] },
  { key: "rpcs3", name: "RPCS3", exe: "rpcs3.exe", args: '--no-gui "{rom}"', extractZip: true, platforms: ["ps3"] },
  { key: "cemu", name: "Cemu", exe: "Cemu.exe", args: '-f -g "{rom}"', extractZip: true, platforms: ["wiiu"] },
  { key: "ryujinx", name: "Ryujinx / Ryubing", exe: "Ryujinx.exe", args: '"{rom}"', extractZip: true, platforms: ["switch"] },
  { key: "azahar", name: "Azahar / Citra", exe: "azahar.exe", args: '"{rom}"', extractZip: true, platforms: ["3ds", "n3ds"] },
  { key: "melonds", name: "melonDS", exe: "melonDS.exe", args: '"{rom}"', extractZip: false, saveMode: "custom", savePattern: "{romDir}/{romName}.sav", statePattern: "{romDir}/{romName}.ml*", platforms: ["nds"] },
  { key: "mgba", name: "mGBA", exe: "mGBA.exe", args: '-f "{rom}"', extractZip: false, saveMode: "custom", savePattern: "{romDir}/{romName}.sav", statePattern: "{romDir}/{romName}.ss*", platforms: ["gba", "gb", "gbc"] },
  { key: "flycast", name: "Flycast", exe: "flycast.exe", args: '"{rom}"', extractZip: false, platforms: ["dc"] },
  { key: "xemu", name: "xemu", exe: "xemu.exe", args: '-full-screen -dvd_path "{rom}"', extractZip: true, platforms: ["xbox"] },
  { key: "xenia", name: "Xenia", exe: "xenia_canary.exe", args: '"{rom}"', extractZip: true, platforms: ["xbox360"] },
  { key: "mame", name: "MAME", exe: "mame.exe", args: '{romName} -rompath "{romDir}"', extractZip: false, platforms: ["arcade", "mame"] },
  { key: "dosbox", name: "DOSBox-X / Staging", exe: "dosbox.exe", args: '"{rom}" -exit', extractZip: true, platforms: ["dos"] },
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
