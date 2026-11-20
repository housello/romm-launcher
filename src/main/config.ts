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
  /** Installed by the launcher from its catalog (see emulatorManager.ts), so it can update it. */
  managed?: ManagedInstall;
  /** Save folders synced with WebDAV; when unset, the catalog's defaults for this emulator. */
  syncFolders?: SyncFolder[];
}

export interface SyncFolder {
  /** The folder's name on WebDAV, under the emulator's own folder there. */
  name: string;
  /** Absolute, %ENV%-prefixed, or relative to the emulator's folder. */
  path: string;
  enabled: boolean;
}

export interface ManagedInstall {
  /** The catalog preset's key. */
  key: string;
  /** Version as shown (release tag, or date for rolling builds). */
  version: string;
  /** Identifies the downloaded file, so a rebuilt "latest" release counts as new. */
  assetKey: string;
  installedAt: number;
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
  /** Where the launcher installs emulators from its catalog, one folder each. */
  emulatorDir: string;
  /** Hide the launcher window while a game is running. */
  minimizeOnLaunch: boolean;
  pageSize: number;
  /** Show one card per game, folding other versions (RomM siblings) into it. */
  groupVersions: boolean;
  /** Send play sessions (start, end, length) to RomM, which shows play time per game. */
  reportPlayTime: boolean;
  /** Look for a newer launcher release on GitHub at start. */
  checkUpdates: boolean;
  /** The game list's sort, as the toolbar menu's value ("name:asc", "created_at:desc", …). */
  sort: string;
  /** The game list as covers or as a details list. */
  viewMode: "grid" | "list";
  /**
   * Where a multi-file game's files go: "subfolder" keeps them in a folder named after
   * the game, "flat" puts them straight in the platform's download folder.
   */
  multiFileLayout: "subfolder" | "flat";
  /** "system" follows Windows' light/dark mode. */
  theme: "system" | "light" | "dark";
  /** Sync saves at all: before a launch and after the emulator exits. */
  syncSaves: boolean;
  /** Where saves sync with: RomM (per game) or a WebDAV folder (per emulator folder). */
  saveBackend: "romm" | "webdav";
  webdav: WebdavSettings;
  /** WebDAV: sync when the launcher starts, and before it closes. */
  webdavSyncOnStart: boolean;
  webdavSyncOnExit: boolean;
  /** Emulators the WebDAV sync covers (ids); unset means every one with save folders. */
  webdavSyncEmulators?: string[];
  /** Encrypted like passwordEnc; never sent to the renderer. */
  webdavPasswordEnc: string;
  /** Where synced saves live, one folder per game; kept when a game copy is deleted. */
  saveDir: string;
  emulators: EmulatorDef[];
  platforms: Record<string, PlatformMapping>;
}

export interface WebdavSettings {
  /** The WebDAV root, e.g. https://cloud.example.com/remote.php/dav/files/me */
  url: string;
  username: string;
  /** Folder under the root that holds the synced save folders. */
  folder: string;
}

/** Shape sent to the renderer: no passwords, only whether they are set. */
export type PublicConfig = Omit<Config, "passwordEnc" | "webdavPasswordEnc"> & { hasPassword: boolean; hasWebdavPassword: boolean };

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
  webdavPasswordEnc: string;
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
      return { passwordEnc: c.passwordEnc ?? "", token: c.token ?? "", webdavPasswordEnc: c.webdavPasswordEnc ?? "" };
    }
    if (existsSync(legacyCredentialsFile())) {
      const c = JSON.parse(readFileSync(legacyCredentialsFile(), "utf8")) as Partial<Credentials>;
      return { passwordEnc: c.passwordEnc ?? "", token: c.token ?? "", webdavPasswordEnc: "" };
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
    emulatorDir: "emulators",
    minimizeOnLaunch: true,
    pageSize: 60,
    groupVersions: true,
    sort: "name:asc",
    viewMode: "grid",
    reportPlayTime: true,
    checkUpdates: true,
    multiFileLayout: "subfolder",
    theme: "system",
    syncSaves: true,
    saveBackend: "romm",
    webdav: { url: "", username: "", folder: "RomM Launcher Saves" },
    webdavPasswordEnc: "",
    webdavSyncOnStart: true,
    webdavSyncOnExit: true,
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
  const { passwordEnc, token, webdavPasswordEnc, ...settings } = next;
  writeCredentials({ passwordEnc, token, webdavPasswordEnc });
  mkdirSync(dataDir(), { recursive: true });
  const tmp = file() + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
  renameSync(tmp, file());
  cached = next;
}

export function publicConfig(config = loadConfig()): PublicConfig {
  const { passwordEnc, webdavPasswordEnc, ...rest } = config;
  return { ...rest, hasPassword: passwordEnc.length > 0, hasWebdavPassword: webdavPasswordEnc.length > 0 };
}

/** Merge a partial update from the renderer. Plain passwords are encrypted here. */
export function updateConfig(patch: Partial<PublicConfig> & { password?: string; webdavPassword?: string }): PublicConfig {
  const current = loadConfig();
  const { password, webdavPassword, hasPassword: _ignored, hasWebdavPassword: _ignored2, ...rest } = patch;
  const next: Config = { ...current, ...rest };
  if (typeof webdavPassword === "string") next.webdavPasswordEnc = webdavPassword ? encrypt(webdavPassword) : "";
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
  return decrypt(config.passwordEnc);
}

export function getWebdavPassword(config = loadConfig()): string {
  return decrypt(config.webdavPasswordEnc);
}

function decrypt(value: string): string {
  if (!value) return "";
  try {
    if (value.startsWith("enc:")) return safeStorage.decryptString(Buffer.from(value.slice(4), "base64"));
    if (value.startsWith("b64:")) return Buffer.from(value.slice(4), "base64").toString("utf8");
  } catch (error) {
    console.error("[config] cannot decrypt password", error);
  }
  return "";
}
