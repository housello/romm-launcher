// New launcher releases from GitHub. The check reads the latest release; the
// update downloads its RomM-Launcher-x.y.z.zip, unpacks RomM-Launcher.exe next to
// the running one as .new, and a small script swaps the two once the launcher has
// closed (Windows keeps a running exe locked), then starts the new one.

import { app, net } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { extractZipEntry } from "./zip";

const LATEST_RELEASE = "https://api.github.com/repos/stemarinacciowork-dev/romm-launcher/releases/latest";
const ASSET_RE = /^RomM-Launcher-(\d+\.\d+\.\d+)\.zip$/;
const EXE = "RomM-Launcher.exe";

export interface UpdateInfo {
  version: string;
  current: string;
  notesUrl: string;
  zipUrl: string;
  size: number;
  /** Whether this copy can replace itself (the packaged exe), or only link to the release. */
  canInstall: boolean;
}

/** "1.2.10" > "1.2.9". */
function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/** The running exe, when it is the packaged portable one (not a development run). */
function installedExe(): string | null {
  const exe = process.env.PORTABLE_EXECUTABLE_FILE;
  return exe && existsSync(exe) ? exe : null;
}

/** The latest release, when it is newer than this launcher; null when up to date. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const response = await net.fetch(LATEST_RELEASE, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "RomM-Launcher" },
  });
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}`);
  const release = (await response.json()) as { html_url?: string; assets?: Array<{ name: string; browser_download_url: string; size: number }> };
  for (const asset of release.assets ?? []) {
    const match = ASSET_RE.exec(asset.name);
    if (!match) continue;
    const version = match[1]!;
    if (!newer(version, app.getVersion())) return null;
    return {
      version,
      current: app.getVersion(),
      notesUrl: release.html_url ?? "",
      zipUrl: asset.browser_download_url,
      size: asset.size,
      canInstall: installedExe() !== null,
    };
  }
  return null;
}

/**
 * Download the update and restart into it. `onProgress` gets bytes received.
 * Resolves only on failure: on success the launcher quits.
 */
export async function installUpdate(update: UpdateInfo, onProgress: (received: number, total: number) => void): Promise<void> {
  const exe = installedExe();
  if (!exe) throw new Error("Only the packaged RomM-Launcher.exe can update itself.");
  const response = await net.fetch(update.zipUrl, { headers: { "User-Agent": "RomM-Launcher" } });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length") ?? update.size ?? 0);
  const chunks: Buffer[] = [];
  let received = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    received += value.length;
    onProgress(received, total);
  }
  const body = extractZipEntry(Buffer.concat(chunks), EXE, 1024 * 1024 * 1024);
  if (body.length < 1024 * 1024 || body.readUInt16LE(0) !== 0x5a4d) throw new Error("The release zip does not hold a valid RomM-Launcher.exe.");

  const fresh = `${exe}.new`;
  await writeFile(fresh, body);
  // Waits for the running exe to be released, swaps it, starts the new one, removes itself.
  const script = join(tmpdir(), `romm-launcher-update-${process.pid}.cmd`);
  await writeFile(script, [
    "@echo off",
    "set tries=0",
    ":retry",
    `move /Y "${fresh}" "${exe}" >nul 2>&1 && goto done`,
    "set /a tries+=1",
    "if %tries% geq 120 goto end",
    "timeout /t 1 /nobreak >nul",
    "goto retry",
    ":done",
    `start "" /D "${dirname(exe)}" "${exe}"`,
    ":end",
    'del "%~f0"',
    "",
  ].join("\r\n"));
  spawn("cmd.exe", ["/c", script], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  app.quit();
}

/** Remove a .new left by an update that could not finish. */
export async function cleanUpUpdate(): Promise<void> {
  const exe = installedExe();
  if (exe) await rm(`${exe}.new`, { force: true }).catch(() => undefined);
}
