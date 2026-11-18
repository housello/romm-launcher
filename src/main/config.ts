// Local settings: server connection, emulators, platform → emulator mapping.
// Stored as a small JSON file in Electron's userData folder. The password is
// encrypted with the OS keychain (safeStorage) when available.

import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export interface EmulatorDef {
  id: string;
  name: string;
  /** Full path to the emulator executable. */
  path: string;
  /** Argument template. Placeholders: {rom} {romDir} {romFile} {romName} {emuDir} {core} */
  args: string;
  /** Unpack .zip ROMs before launching (for emulators that cannot read archives). */
  extractZip: boolean;
  /**
   * How saves are found for sync. "retroarch": saves/states are pinned to a
   * per-game folder via --appendconfig. "custom": savePattern/statePattern.
   * Missing on configs from before save sync; inferred from the executable.
   */
  saveMode?: "off" | "retroarch" | "custom";
  /** File pattern for saves, e.g. "{romDir}\{romName}.sav". "*" allowed in the file name. */
  savePattern?: string;
  /** File pattern for save states. */
  statePattern?: string;
}

export interface PlatformMapping {
  emulatorId: string;
  /** Libretro core name (e.g. "snes9x") used by the {core} placeholder. */
  core?: string;
  /** Overrides the emulator's argument template for this platform only. */
  args?: string;
  /** Where this platform's games are downloaded; default <romDir><slug>. */
  folder?: string;
}

export interface Config {
  serverUrl: string;
  authType: "basic" | "token";
  username: string;
  /** Encrypted (base64) when safeStorage is available, otherwise plain base64. */
  passwordEnc: string;
  token: string;
  allowSelfSigned: boolean;
  romDir: string;
  /** Hide the launcher window while a game is running. */
  minimizeOnLaunch: boolean;
  pageSize: number;
  /** Show one card per game, folding other versions (RomM siblings) into it. */
  groupVersions: boolean;
  /** Pull saves/states from RomM before a launch and push changes after exit. */
  syncSaves: boolean;
  /** Where synced saves live, one folder per game; kept when a game copy is deleted. */
  saveDir: string;
  emulators: EmulatorDef[];
  platforms: Record<string, PlatformMapping>;
}

/** Shape sent to the renderer: no password, only whether one is set. */
export type PublicConfig = Omit<Config, "passwordEnc"> & { hasPassword: boolean };

const file = () => join(app.getPath("userData"), "launcher-config.json");

function defaults(): Config {
  return {
    serverUrl: "",
    authType: "basic",
    username: "",
    passwordEnc: "",
    token: "",
    allowSelfSigned: false,
    romDir: join(app.getPath("userData"), "roms"),
    minimizeOnLaunch: true,
    pageSize: 60,
    groupVersions: true,
    syncSaves: true,
    saveDir: join(app.getPath("userData"), "saves"),
    emulators: [],
    platforms: {},
  };
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  let stored: Partial<Config> = {};
  try {
    if (existsSync(file())) stored = JSON.parse(readFileSync(file(), "utf8"));
  } catch (error) {
    console.error("[config] unreadable, using defaults", error);
  }
  cached = { ...defaults(), ...stored };
  return cached;
}

export function saveConfig(next: Config): void {
  mkdirSync(app.getPath("userData"), { recursive: true });
  const tmp = file() + ".tmp";
  writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  renameSync(tmp, file());
  cached = next;
}

export function publicConfig(config = loadConfig()): PublicConfig {
  const { passwordEnc, ...rest } = config;
  return { ...rest, hasPassword: passwordEnc.length > 0 };
}

/** Merge a partial update from the renderer. `password` (plain) is encrypted here. */
export function updateConfig(patch: Partial<PublicConfig> & { password?: string }): PublicConfig {
  const current = loadConfig();
  const { password, hasPassword: _ignored, ...rest } = patch;
  const next: Config = { ...current, ...rest };
  if (typeof next.serverUrl === "string") next.serverUrl = next.serverUrl.trim().replace(/\/+$/, "");
  if (typeof password === "string") next.passwordEnc = password ? encrypt(password) : "";
  saveConfig(next);
  return publicConfig(next);
}

function encrypt(plain: string): string {
  if (safeStorage.isEncryptionAvailable()) return "enc:" + safeStorage.encryptString(plain).toString("base64");
  return "b64:" + Buffer.from(plain, "utf8").toString("base64");
}

export function getPassword(config = loadConfig()): string {
  const value = config.passwordEnc;
  if (!value) return "";
  try {
    if (value.startsWith("enc:")) return safeStorage.decryptString(Buffer.from(value.slice(4), "base64"));
    if (value.startsWith("b64:")) return Buffer.from(value.slice(4), "base64").toString("utf8");
  } catch (error) {
    console.error("[config] cannot decrypt password", error);
  }
  return "";
}
