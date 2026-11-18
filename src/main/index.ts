import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { apiGet, ApiError } from "./api";
import { loadConfig, publicConfig, updateConfig } from "./config";
import { saveModeOf, DEFAULT_CORES, detectRetroArch, listCores, PRESETS } from "./emulators";
import { clearImageCache, imageCacheSize, registerImageProtocol, registerImageSchemePrivileges } from "./images";
import { getInstalled, listInstalled } from "./library";
import { cancel, resolveFileChoice, syncNow, install, launch, LaunchError, resolveEmulator, runningGames, setLaunchFile, uninstall, type LaunchEvent } from "./launcher";

// Portable / test data folder: set ROMM_LAUNCHER_DATA to keep settings elsewhere.
if (process.env.ROMM_LAUNCHER_DATA) app.setPath("userData", process.env.ROMM_LAUNCHER_DATA);

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

registerImageSchemePrivileges();

let win: BrowserWindow | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#111318",
    title: "RomM Launcher",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(join(__dirname, "..", "..", "renderer", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
}

const emit = (event: LaunchEvent) => {
  if (win && !win.isDestroyed()) win.webContents.send("launch-event", event);
};

/** Wrap a handler so errors reach the renderer as { error } instead of an opaque rejection. */
function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (error) {
      const code = error instanceof LaunchError ? error.code : error instanceof ApiError ? `http-${error.status}` : "failed";
      console.error(`[ipc] ${channel}`, error);
      return { ok: false, error: (error as Error).message, code };
    }
  });
}

function romQuery(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : null);
  const platform = num(params.platformId);
  if (platform) {
    q.append("platform_ids", platform); // RomM 5.x
    q.append("platform_id", platform); // RomM 4.x
  }
  const collection = num(params.collectionId);
  if (collection) q.append("collection_id", collection);
  if (typeof params.search === "string" && params.search.trim()) q.append("search_term", params.search.trim());
  if (params.favourite) q.append("favourite", "true");
  // One card per game: RomM folds other versions (regions, revisions) into sibling_roms.
  if (loadConfig().groupVersions) q.append("group_by_meta_id", "true");
  q.append("limit", num(params.limit) ?? String(loadConfig().pageSize));
  q.append("offset", num(params.offset) ?? "0");
  q.append("order_by", typeof params.orderBy === "string" ? params.orderBy : "name");
  q.append("order_dir", params.orderDir === "desc" ? "desc" : "asc");
  return q.toString();
}

/** This ROM plus its RomM siblings (other versions of the same game), or [] when there are none. */
function versionsOf(r: any): Array<{ id: number; name: string; fileName: string; installed: boolean }> {
  const siblings: any[] = Array.isArray(r.sibling_roms) ? r.sibling_roms : [];
  if (!siblings.length) return [];
  const all = [r, ...siblings.filter((x) => x?.id !== r.id)];
  return all
    .filter((x) => typeof x?.id === "number")
    .map((x) => ({
      id: x.id,
      name: x.name || x.fs_name_no_ext || x.fs_name || `#${x.id}`,
      fileName: x.fs_name_no_ext || x.fs_name || "",
      installed: !!getInstalled(x.id),
    }))
    .sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true }));
}

/** Screenshots as { server path, external URL } pairs, like covers. */
function screenshotsOf(r: any): Array<{ s: string; u: string }> {
  const local: string[] = (r.merged_screenshots ?? r.path_screenshots ?? []).filter((x: unknown) => typeof x === "string");
  const remote: string[] = (r.url_screenshots ?? []).filter((x: unknown) => typeof x === "string");
  const n = Math.min(8, Math.max(local.length, remote.length));
  return Array.from({ length: n }, (_, i) => ({ s: local[i] ?? "", u: remote[i] ?? "" }));
}

const saveRow = (s: any) => ({ id: s.id, name: s.file_name, emulator: s.emulator ?? null, size: s.file_size_bytes ?? 0, updatedAt: s.updated_at ?? null });

function registerIpc(): void {
  handle("config:get", () => publicConfig());
  handle("config:set", (patch) => updateConfig(patch));

  handle("server:test", async () => {
    const me = await apiGet<{ username?: string; role?: string }>("/api/users/me");
    let version: string | null = null;
    try {
      const beat = await apiGet<{ SYSTEM?: { VERSION?: string } }>("/api/heartbeat");
      version = beat?.SYSTEM?.VERSION ?? null;
    } catch {
      /* optional */
    }
    return { username: me.username ?? "?", role: me.role ?? "", version };
  });

  handle("platforms:list", async () => {
    const list = await apiGet<any[]>("/api/platforms");
    return list
      .map((p) => ({
        id: p.id,
        slug: p.slug,
        fsSlug: p.fs_slug,
        name: p.display_name || p.custom_name || p.name,
        romCount: p.rom_count ?? 0,
      }))
      .filter((p) => p.romCount > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  handle("collections:list", async () => {
    try {
      const list = await apiGet<any[]>("/api/collections");
      return list.map((c) => ({ id: c.id, name: c.name, romCount: c.rom_count ?? c.rom_ids?.length ?? 0 }));
    } catch {
      return [];
    }
  });

  handle("roms:list", async (params: Record<string, unknown>) => {
    const body = await apiGet<any>(`/api/roms?${romQuery(params ?? {})}`);
    const items: any[] = Array.isArray(body) ? body : (body.items ?? []);
    const total: number = Array.isArray(body) ? items.length : (body.total ?? items.length);
    return {
      total,
      items: items.map((r) => ({
        id: r.id,
        name: r.name || r.fs_name_no_ext || r.fs_name,
        platformSlug: r.platform_slug,
        platformName: r.platform_display_name || r.platform_name || r.platform_slug,
        cover: r.path_cover_small || r.path_cover_large || null,
        coverUrl: r.url_cover || null,
        year: r.first_release_date ? new Date(Number(r.first_release_date)).getFullYear() : null,
        installed: !!getInstalled(r.id),
        versions: loadConfig().groupVersions ? versionsOf(r) : [],
      })),
    };
  });

  handle("rom:get", async (id: number) => {
    const r = await apiGet<any>(`/api/roms/${id}`);
    const resolved = resolveEmulator([r.platform_slug, r.platform_fs_slug]);
    return {
      id: r.id,
      name: r.name || r.fs_name_no_ext || r.fs_name,
      fsName: r.fs_name,
      summary: r.summary ?? "",
      platformSlug: r.platform_slug,
      platformName: r.platform_display_name || r.platform_name || r.platform_slug,
      cover: r.path_cover_large || r.path_cover_small || null,
      coverUrl: r.url_cover || null,
      screenshots: screenshotsOf(r),
      sizeBytes: r.fs_size_bytes ?? 0,
      files: (r.files ?? []).map((f: any) => ({ name: f.file_name, size: f.file_size_bytes ?? 0 })),
      regions: r.regions ?? [],
      languages: r.languages ?? [],
      genres: r.metadatum?.genres ?? r.genres ?? [],
      companies: r.metadatum?.companies ?? r.companies ?? [],
      year: r.metadatum?.first_release_date || r.first_release_date ? new Date(Number(r.metadatum?.first_release_date ?? r.first_release_date)).getFullYear() : null,
      emulator: resolved ? resolved.emulator.name + (resolved.mapping.core ? ` (${resolved.mapping.core})` : "") : null,
      installed: getInstalled(id),
      versions: versionsOf(r),
      running: runningGames().includes(id),
      webUrl: `${loadConfig().serverUrl}/rom/${id}`,
      saveMode: resolved ? saveModeOf(resolved.emulator) : "off",
      syncSaves: loadConfig().syncSaves,
      saves: (r.user_saves ?? []).map(saveRow),
      states: (r.user_states ?? []).map(saveRow),
    };
  });

  handle("game:play", (id: number) =>
    launch(id, emit, {
      onStart: () => {
        if (loadConfig().minimizeOnLaunch) win?.minimize();
      },
      onExit: () => {
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore();
          win.focus();
        }
      },
    }).catch((error) => {
      emit({ romId: id, type: "idle" });
      throw error;
    }),
  );
  handle("game:install", async (id: number) => {
    const r = await apiGet<any>(`/api/roms/${id}`);
    const resolved = resolveEmulator([r.platform_slug, r.platform_fs_slug]);
    return install(id, emit, { extractZip: resolved?.emulator.extractZip ?? false }).catch((error) => {
      emit({ romId: id, type: "idle" });
      throw error;
    });
  });
  handle("game:chooseFile", (id: number, rel: string | null) => resolveFileChoice(id, rel));
  handle("game:syncSaves", (id: number) => syncNow(id, emit));
  handle("game:uninstall", (id: number) => uninstall(id));
  handle("game:cancel", (id: number) => cancel(id));
  handle("game:setLaunchFile", (id: number, rel: string) => setLaunchFile(id, rel));
  handle("game:openFolder", (id: number) => {
    const game = getInstalled(id);
    if (game) shell.openPath(game.dir);
  });
  handle("installed:list", () => listInstalled());
  handle("running:list", () => runningGames());

  handle("emulators:presets", () => ({ presets: PRESETS, defaultCores: DEFAULT_CORES }));
  handle("emulators:detectRetroArch", () => detectRetroArch());
  handle("emulators:cores", (path: string) => listCores(path));
  handle("emulators:exists", (path: string) => !!path && existsSync(path));

  handle("dialog:pickExe", async () => {
    const result = await dialog.showOpenDialog(win!, {
      properties: ["openFile"],
      filters: [{ name: "Programs", extensions: ["exe", "bat", "cmd"] }, { name: "All files", extensions: ["*"] }],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle("dialog:pickFolder", async () => {
    const result = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle("cache:info", async () => {
    const games = listInstalled();
    return {
      imageBytes: await imageCacheSize(),
      romBytes: games.reduce((sum, g) => sum + (g.sizeBytes || 0), 0),
      romCount: games.length,
    };
  });
  handle("cache:clearImages", () => clearImageCache());
  handle("open:external", (url: string) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
}

app.whenReady().then(() => {
  registerImageProtocol();
  registerIpc();
  createWindow();
});

app.on("window-all-closed", () => app.quit());
