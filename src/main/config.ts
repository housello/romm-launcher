// Local settings: server connection, emulators, platform → emulator mapping.
// Stored as a small JSON file in the data folder (AppData, or next to the exe in portable mode); the
// login is kept apart, encrypted (see credentials.dat below).

import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, isPortable } from "./paths";

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
  /** "system" follows Windows' light/dark mode. */
  theme: "system" | "light" | "dark";
  /** Pull saves/states from RomM before a launch and push changes after exit. */
  syncSaves: boolean;
  /** Where synced saves live, one folder per game; kept when a game copy is deleted. */
  saveDir: string;
  emulators: EmulatorDef[];
  platforms: Record<string, PlatformMapping>;
}

/** Shape sent to the renderer: no password, only whether one is set. */
export type PublicConfig = Omit<Config, "passwordEnc"> & { hasPassword: boolean };

const file = () => join(dataDir(), "launcher-config.json");
/**
 * Password and token live apart from the settings, in credentials.dat next to them:
 * the whole file is encrypted with Windows' data protection (Electron safeStorage),
 * so it is not readable text. It can only be decrypted by the same Windows user with
 * the same data folder; elsewhere the login is simply asked for again.
 */
const credentialsFile = () => join(dataDir(), "credentials.dat");
/** Written by a development build before the switch to the encrypted file. */
const legacyCredentialsFile = () => join(dataDir(), "credentials.json");

interface Credentials {
  passwordEnc: string;
  token: string;
}

function readCredentials(): Credentials | null {
  try {
    if (existsSync(credentialsFile())) {
      const raw = readFileSync(credentialsFile());
      // "RLB1" = only obfuscated: this system has no OS encryption (rare on Windows).
      const text = raw.subarray(0, 4).toString() === "RLB1"
        ? Buffer.from(raw.subarray(4).toString(), "base64").toString("utf8")
        : safeStorage.decryptString(raw);
      const c = JSON.parse(text) as Partial<Credentials>;
      return { passwordEnc: c.passwordEnc ?? "", token: c.token ?? "" };
    }
    if (existsSync(legacyCredentialsFile())) {
      const c = JSON.parse(readFileSync(legacyCredentialsFile(), "utf8")) as Partial<Credentials>;
      return { passwordEnc: c.passwordEnc ?? "", token: c.token ?? "" };
    }
  } catch (error) {
    // Another PC / Windows user: the login has to be entered again.
    console.warn("[config] saved login cannot be decrypted here", error);
  }
  return null;
}

function writeCredentials(c: Credentials): void {
  mkdirSync(dataDir(), { recursive: true });
  const text = JSON.stringify(c);
  const bytes = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(text)
    : Buffer.concat([Buffer.from("RLB1"), Buffer.from(Buffer.from(text, "utf8").toString("base64"))]);
  writeFileSync(credentialsFile() + ".tmp", bytes);
  renameSync(credentialsFile() + ".tmp", credentialsFile());
  if (existsSync(legacyCredentialsFile())) rmSync(legacyCredentialsFile(), { force: true });
}

function defaults(): Config {
  return {
    serverUrl: "",
    authType: "basic",
    username: "",
    passwordEnc: "",
    token: "",
    allowSelfSigned: false,
    // Portable: next to the exe (relative); otherwise in AppData.
    romDir: isPortable() ? "roms" : join(app.getPath("userData"), "roms"),
    minimizeOnLaunch: true,
    pageSize: 60,
    groupVersions: true,
    theme: "system",
    syncSaves: true,
    saveDir: isPortable() ? "saves" : join(app.getPath("userData"), "saves"),
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
  const credentials = readCredentials();
  cached = { ...defaults(), ...stored, ...(credentials ?? {}) };
  // Settings written before the split still hold the secrets: move them out once.
  const legacy = (stored.passwordEnc || stored.token) && !credentials;
  if (legacy || "passwordEnc" in stored || "token" in stored) saveConfig(cached);
  return cached;
}

export function saveConfig(next: Config): void {
  const { passwordEnc, token, ...settings } = next;
  writeCredentials({ passwordEnc, token });
  mkdirSync(dataDir(), { recursive: true });
  const tmp = file() + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
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
