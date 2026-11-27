import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiFetch, apiGet, ApiError } from "./api";
import { baseDir, canSwitchLocation, dataDir, dataLocations, isPortable, resolvePath, setupDataFolder, switchDataLocation, toStored } from "./paths";
import { loadConfig, publicConfig, updateConfig } from "./config";
import { saveModeOf, DEFAULT_CORES, detectRetroArch, listCores, PRESETS } from "./emulators";
import { clearImageCache, imageCacheSize, registerImageProtocol, registerImageSchemePrivileges } from "./images";
import { getInstalled, listInstalled, metaOf, putInstalled } from "./library";
import { checkServer, isOffline, isUnreachable, noteFailure, onConnectionChange } from "./connection";
import { flushSessions } from "./playSessions";
import { checkForUpdate, cleanUpUpdate, installUpdate, type UpdateInfo } from "./updater";
import { adoptEmulator, checkEmulatorUpdates, installCores, installEmulator, managedFolder, releaseEmulator } from "./emulatorManager";
import { lastVersions, rememberVersion } from "./lastVersions";
import { applyRenames, buildPlan, undoInfo, undoLast } from "./mame";
import { setGameEmulator, type GameEmulator } from "./gameEmulators";
import { applyArcadeDb, type AdbOptions } from "./arcadedb";
import { mediaFolder, mediaOf, openMedia, saveMedia } from "./media";
import { guessList, listXmlFromExe, mameExes, softwareLists } from "./mameSources";
import { presetOf, syncFoldersOf, localPathOf, storedFolderPath, webdavClient } from "./folderSync";
import { cancel, resolveDownloadChoice, verifyDownloads, openEmulator, resolveConflicts, syncAllFolders, webdavSyncOn, resolveFileChoice, syncNow, install, launch, LaunchError, resolveEmulator, runningGames, setLaunchFile, uninstall, type LaunchEvent } from "./launcher";

// Test data folder: ROMM_LAUNCHER_DATA keeps settings elsewhere. The packaged launcher keeps
// everything next to its exe unless an "appdata" file is there (see paths.ts); that wins.
if (process.env.ROMM_LAUNCHER_DATA) app.setPath("userData", process.env.ROMM_LAUNCHER_DATA);
setupDataFolder();

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

registerImageSchemePrivileges();

let win: BrowserWindow | null = null;
/** Set once the close-time save sync is done (or skipped), so the window really closes. */
let quitting = false;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111318" : "#f4f5f8",
    title: "RomM Launcher",
    icon: join(__dirname, "..", "..", "renderer", "icon.png"),
    autoHideMenuBar: true,
    fullscreen: !!loadConfig().fullscreen,
    webPreferences: {
      preload: join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(join(__dirname, "..", "..", "renderer", "index.html"));
  // WebDAV: sync the save folders before closing; the window shows it and can skip it.
  win.on("close", (event) => {
    if (quitting || !webdavSyncOn() || !loadConfig().webdavSyncOnExit) return;
    event.preventDefault();
    win?.webContents.send("closing-sync");
  });
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
/** Portable: file pickers open in the launcher's folder, where its paths are relative to. */
function browseStart(): { defaultPath?: string } {
  return isPortable() ? { defaultPath: baseDir() } : {};
}

function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (error) {
      noteFailure(error);
      const code = isUnreachable(error) ? "offline"
        : error instanceof LaunchError ? error.code : error instanceof ApiError ? `http-${error.status}` : "failed";
      console.error(`[ipc] ${channel}`, error);
      return { ok: false, error: (error as Error).message, code };
    }
  });
}

/** Yes/no filters RomM's /api/roms understands. */
const FLAG_FILTERS = ["favorite", "matched", "duplicate", "has_saves", "has_states", "has_ra", "verified", "missing", "last_played", "playable"];
/** Multi-value filters: repeated query keys (genres=a&genres=b). */
const LIST_FILTERS = ["genres", "franchises", "collections", "companies", "publishers", "developers", "age_ratings", "player_counts", "regions", "languages", "statuses", "tags"];

function appendFilters(q: URLSearchParams, filters: unknown): void {
  if (!filters || typeof filters !== "object") return;
  const { flags, lists } = filters as { flags?: Record<string, unknown>; lists?: Record<string, unknown> };
  for (const key of FLAG_FILTERS) {
    const v = flags?.[key];
    if (v === true || v === false) q.append(key, String(v));
  }
  for (const key of LIST_FILTERS) {
    const values = lists?.[key];
    if (!Array.isArray(values)) continue;
    for (const v of values) if (typeof v === "string" && v) q.append(key, v);
  }
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
  const smartCollection = num(params.smartCollectionId);
  if (smartCollection) q.append("smart_collection_id", smartCollection);
  if (typeof params.search === "string" && params.search.trim()) q.append("search_term", params.search.trim());
  appendFilters(q, params.filters);
  // One card per game: RomM folds other versions (regions, revisions) into sibling_roms.
  if (loadConfig().groupVersions) q.append("group_by_meta_id", "true");
  q.append("limit", num(params.limit) ?? String(loadConfig().pageSize));
  q.append("offset", num(params.offset) ?? "0");
  q.append("order_by", typeof params.orderBy === "string" ? params.orderBy : "name");
  q.append("order_dir", params.orderDir === "desc" ? "desc" : "asc");
  return q.toString();
}

/** A RomM rom as a library card. */
function romItem(r: any) {
  const released = r.metadatum?.first_release_date ?? r.first_release_date;
  return {
    id: r.id,
    name: r.name || r.fs_name_no_ext || r.fs_name,
    platformSlug: r.platform_slug,
    platformName: r.platform_display_name || r.platform_name || r.platform_slug,
    cover: r.path_cover_small || r.path_cover_large || null,
    coverUrl: r.url_cover || null,
    year: released ? new Date(Number(released)).getFullYear() : null,
    installed: !!getInstalled(r.id),
    versions: loadConfig().groupVersions ? versionsOf(r) : [],
    details: listDetails(r, released),
  };
}

/** Everything the details view can show for a game in a list, from what RomM sends anyway. */
function listDetails(r: any, released: unknown) {
  const m = r.metadatum ?? {};
  const names = (v: unknown) => (Array.isArray(v) ? v.map((x: any) => (typeof x === "string" ? x : x?.name ?? "")).filter(Boolean) : []);
  const user = r.rom_user ?? {};
  return {
    released: released ? new Date(Number(released)).toISOString().slice(0, 10) : "",
    genres: names(m.genres),
    developers: names(m.developers).length ? names(m.developers) : names(m.companies),
    publishers: names(m.publishers),
    franchises: names(m.franchises),
    gameModes: names(m.game_modes),
    ageRatings: names(m.age_ratings),
    players: m.player_count ? String(m.player_count) : "",
    rating: typeof m.average_rating === "number" && m.average_rating > 0 ? Math.round(m.average_rating * 10) / 10 : null,
    regions: names(r.regions),
    languages: names(r.languages),
    revision: r.revision || r.version || "",
    tags: names(r.tags),
    file: r.fs_name || "",
    size: typeof r.fs_size_bytes === "number" ? r.fs_size_bytes : null,
    added: r.created_at ? String(r.created_at).slice(0, 10) : "",
    lastPlayed: user.last_played ? String(user.last_played).slice(0, 10) : "",
    status: user.status || "",
    myRating: user.rating ? Number(user.rating) : null,
    missing: !!r.missing_from_fs,
  };
}

const HOME_ROW = 15;
const FACETS: Record<string, string> = {
  collection: "Same collection", franchise: "Same franchise", genre: "Same genre", perspective: "Same perspective",
  theme: "Same theme", keyword: "Similar themes", developer: "Same developer", publisher: "Same publisher",
  company: "Same company", game_mode: "Same game modes", platform: "Same platform", decade: "Same decade",
  igdb: "Similar on IGDB", top_rated: "Top rated",
};

/** Why RomM recommends a game, in a few words, as its web home page captions it. */
function reasonOf(rec: any): string {
  if (rec.seed_rom_name) return `Because you played ${rec.seed_rom_name}`;
  const reason = Array.isArray(rec.reasons) ? rec.reasons[0] : null;
  if (!reason) return "";
  return reason.value ? String(reason.value) : (FACETS[reason.facet] ?? "");
}

/**
 * The rows of RomM's web home page, from the same API calls (RomM 5.5). A row the
 * server cannot answer (an older RomM has no recommendations) is left out.
 */
async function homeSections() {
  const roms = async (params: Record<string, string | string[]>) => {
    const q = new URLSearchParams({ with_char_index: "false", with_filter_values: "false", with_rom_id_index: "false" });
    for (const [k, v] of Object.entries(params)) for (const x of [v].flat()) q.append(k, x);
    const body = await apiGet<any>(`/api/roms?${q}`);
    return { items: ((Array.isArray(body) ? body : body.items) ?? []).map(romItem), total: Array.isArray(body) ? body.length : (body.total ?? 0) };
  };
  const now = new Date();
  const days = [`${now.getMonth() + 1}-${now.getDate()}`];
  const leap = new Date(now.getFullYear(), 1, 29).getMonth() === 1;
  if (days[0] === "2-28" && !leap) days.push("2-29");
  const year = now.getFullYear();

  const favourite = async () => {
    const [list, me] = await Promise.all([apiGet<any[]>("/api/collections"), apiGet<{ id?: number }>("/api/users/me").catch(() => ({}) as { id?: number })]);
    const fav = list.find((c) => c.is_favorite && (me.id === undefined || c.user_id === undefined || c.user_id === me.id));
    if (!fav) return { items: [] };
    return roms({ collection_id: String(fav.id), order_by: "name", order_dir: "asc", limit: "30" });
  };
  const jobs: Record<string, Promise<any>> = {
    continue: roms({ order_by: "last_played", order_dir: "desc", last_played: "true", limit: String(HOME_ROW), with_total: "false" }),
    recommended: apiGet<any[]>(`/api/recommendations?limit=${HOME_ROW}`).then((list) => ({
      items: (Array.isArray(list) ? list : []).filter((x) => x?.rom?.id).map((x) => ({ ...romItem(x.rom), reason: reasonOf(x) })),
    })),
    // 1 January is where undated releases pile up, so RomM's web page skips it too.
    anniversaries: days[0] === "1-1"
      ? Promise.resolve({ items: [] })
      : roms({ released_days: days, released_before_year: String(year), order_by: "first_release_date", order_dir: "asc", limit: "24", with_total: "true" })
        .then((page) => ({ ...page, items: page.items.map((r: any) => ({ ...r, reason: r.year && year - r.year >= 1 ? `${year - r.year} years ago` : "" })) })),
    recent: roms({ order_by: "id", order_dir: "desc", limit: String(HOME_ROW), with_total: "false" }),
    favourites: favourite(),
    random: apiGet<any>("/api/roms/random").then((r) => ({ items: r?.id ? [romItem(r)] : [] })),
  };
  const keys = Object.keys(jobs);
  const results = await Promise.allSettled(Object.values(jobs));
  const out: Record<string, { items: any[]; total?: number } | null> = {};
  results.forEach((res, i) => { out[keys[i]] = res.status === "fulfilled" ? res.value : null; });
  // Every row failing means RomM itself is unreachable: say so instead of an empty page.
  if (results.every((r) => r.status === "rejected")) throw (results[0] as PromiseRejectedResult).reason;
  return out;
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

async function createCollection(name: string, isPublic: boolean, isFavorite = false): Promise<{ id: number; name: string }> {
  const boundary = "----romm" + Math.random().toString(16).slice(2);
  const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n--${boundary}--\r\n`, "utf8");
  const q = new URLSearchParams({ is_public: String(isPublic), ...(isFavorite ? { is_favorite: "true" } : {}) });
  const response = await apiFetch(`/api/collections?${q}`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Could not create the collection (HTTP ${response.status}).`);
  const c = (await response.json()) as { id: number; name: string };
  return { id: c.id, name: c.name };
}

function registerIpc(): void {
  handle("config:get", () => publicConfig());
  handle("versions:last", () => lastVersions());
  handle("versions:remember", (versionIds, chosen) => rememberVersion(versionIds, chosen));
  handle("config:set", (patch) => {
    const next = updateConfig(patch);
    applyTheme();
    return next;
  });

  handle("user:me", async () => {
    const me = await apiGet<{ username?: string }>("/api/users/me", 8_000);
    return { username: me.username ?? "" };
  });
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
    const [list, smart, me] = await Promise.all([
      apiGet<any[]>("/api/collections"),
      // Smart collections (RomM 5.x) are built from filters; older servers have none.
      apiGet<any[]>("/api/collections/smart").catch(() => [] as any[]),
      apiGet<{ id?: number }>("/api/users/me").catch(() => ({}) as { id?: number }),
    ]);
    const cover = (c: any) => c.path_cover_small || (Array.isArray(c.path_covers_small) ? c.path_covers_small[0] : null) || c.url_cover || null;
    return [
      ...list.map((c) => ({
        key: String(c.id),
        id: c.id,
        smart: false,
        name: c.name,
        romCount: c.rom_count ?? c.rom_ids?.length ?? 0,
        isFavorite: !!c.is_favorite,
        description: c.description ?? "",
        owner: c.owner_username ?? "",
        cover: cover(c),
        isPublic: !!c.is_public,
        // Only your own collections can be changed; public ones of other users are read-only.
        mine: me.id === undefined || c.user_id === undefined || c.user_id === me.id,
      })),
      ...(Array.isArray(smart) ? smart : []).map((c) => ({
        key: `smart:${c.id}`,
        id: c.id,
        smart: true,
        name: c.name,
        romCount: c.rom_count ?? c.rom_ids?.length ?? 0,
        isFavorite: false,
        description: c.description ?? "",
        owner: c.owner_username ?? "",
        cover: cover(c),
        isPublic: !!c.is_public,
        // Its games follow its filters, so games cannot be added or removed by hand.
        mine: false,
      })),
    ];
  });

  // Values for the filter menus, for the current view (only what occurs there).
  handle("roms:filterValues", async (params: { platformId?: number; collectionId?: number; smartCollectionId?: number }) => {
    const q = new URLSearchParams({ limit: "1", offset: "0", with_filter_values: "true" });
    if (typeof params?.platformId === "number") q.append("platform_ids", String(params.platformId));
    if (typeof params?.collectionId === "number") q.append("collection_id", String(params.collectionId));
    if (typeof params?.smartCollectionId === "number") q.append("smart_collection_id", String(params.smartCollectionId));
    const body = await apiGet<{ filter_values?: Record<string, unknown> }>(`/api/roms?${q}`);
    const out: Record<string, string[]> = {};
    for (const key of LIST_FILTERS) {
      const v = body.filter_values?.[key];
      if (Array.isArray(v)) out[key] = v.filter((x): x is string => typeof x === "string" && x.length > 0);
    }
    return out;
  });

  handle("collections:create", async (name: string, isPublic: boolean) => {
    const clean = String(name ?? "").trim();
    if (!clean) throw new Error("A collection needs a name.");
    return createCollection(clean, !!isPublic);
  });

  const collectionRoms = async (method: "POST" | "DELETE", id: number, romIds: number[]) => {
    const ids = (Array.isArray(romIds) ? romIds : []).filter((x) => Number.isInteger(x));
    if (!Number.isInteger(id) || !ids.length) throw new Error("Nothing to change.");
    const response = await apiFetch(`/api/collections/${id}/roms`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rom_ids: ids }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const hint = response.status === 403 ? " (only the owner can change a collection)" : "";
      throw new Error(`RomM refused the change (HTTP ${response.status})${hint}.`);
    }
    return true;
  };
  handle("collections:delete", async (id: number) => {
    if (!Number.isInteger(id)) throw new Error("Unknown collection.");
    const response = await apiFetch(`/api/collections/${id}`, { method: "DELETE", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`RomM refused to delete the collection (HTTP ${response.status}).`);
    return true;
  });
  handle("collections:addRoms", (id: number, romIds: number[]) => collectionRoms("POST", id, romIds));
  // ★ Favourite: RomM keeps favourites in a collection of yours flagged is_favorite.
  handle("collections:setFavorite", async (romId: number, on: boolean) => {
    const [list, me] = await Promise.all([apiGet<any[]>("/api/collections"), apiGet<{ id?: number }>("/api/users/me")]);
    let fav = list.find((c) => c.is_favorite && (me.id === undefined || c.user_id === undefined || c.user_id === me.id));
    if (!fav) {
      if (!on) return false;
      fav = await createCollection("Favourites", false, true);
    }
    await collectionRoms(on ? "POST" : "DELETE", fav.id, [romId]);
    return !!on;
  });
  handle("collections:removeRoms", (id: number, romIds: number[]) => collectionRoms("DELETE", id, romIds));

  handle("roms:list", async (params: Record<string, unknown>) => {
    const body = await apiGet<any>(`/api/roms?${romQuery(params ?? {})}`);
    const items: any[] = Array.isArray(body) ? body : (body.items ?? []);
    const total: number = Array.isArray(body) ? items.length : (body.total ?? items.length);
    return {
      total,
      items: items.map(romItem),
    };
  });

  handle("home:sections", () => homeSections());
  handle("home:random", async () => {
    const r = await apiGet<any>("/api/roms/random");
    return r?.id ? romItem(r) : null;
  });

  handle("rom:get", async (id: number) => {
    if (isOffline()) return offlineDetail(id);
    let r: any;
    try {
      r = await apiGet<any>(`/api/roms/${id}`);
    } catch (error) {
      if (!isUnreachable(error)) throw error;
      noteFailure(error);
      return offlineDetail(id);
    }
    const resolved = resolveEmulator([r.platform_slug, r.platform_fs_slug], id);
    const platformOnly = resolveEmulator([r.platform_slug, r.platform_fs_slug]);
    // Refresh what a downloaded game shows offline.
    const local = getInstalled(id);
    if (local) putInstalled({ ...local, meta: metaOf(r) });
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
      emulatorId: resolved?.emulator.id ?? null,
      emulatorCore: resolved?.mapping.core ?? null,
      perGameEmulator: !!resolved?.perGame,
      platformEmulator: platformOnly ? platformOnly.emulator.name + (platformOnly.mapping.core ? ` (${platformOnly.mapping.core})` : "") : null,
      installed: getInstalled(id),
      versions: versionsOf(r),
      running: runningGames().includes(id),
      webUrl: `${loadConfig().serverUrl}/rom/${id}`,
      collections: (Array.isArray(r.user_collections) ? r.user_collections : []).map((c: any) => ({ id: c.id, name: c.name, isFavorite: !!c.is_favorite })),
      saveMode: resolved ? saveModeOf(resolved.emulator) : "off",
      syncSaves: loadConfig().syncSaves,
      media: mediaOf(r),
      saves: (r.user_saves ?? []).map(saveRow),
      states: (r.user_states ?? []).map(saveRow),
    };
  });

  handle("game:play", (id: number, once?: unknown, context?: { collection?: unknown }) =>
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
    }, gameChoice(once), { collection: typeof context?.collection === "string" ? context.collection : undefined }).catch((error) => {
      emit({ romId: id, type: "idle" });
      throw error;
    }),
  );
  // Remember an emulator (and core) for one game; null goes back to the platform's.
  handle("game:setEmulator", (id: number, choice: unknown) => {
    setGameEmulator(Number(id), gameChoice(choice));
    return true;
  });
  handle("game:install", async (id: number) => {
    const r = await apiGet<any>(`/api/roms/${id}`);
    const resolved = resolveEmulator([r.platform_slug, r.platform_fs_slug], id);
    return install(id, emit, { extractZip: resolved?.emulator.extractZip ?? false }).catch((error) => {
      emit({ romId: id, type: "idle" });
      throw error;
    });
  });
  handle("game:chooseFile", (id: number, rel: string | null) => resolveFileChoice(id, rel));
  handle("game:chooseDownload", (id: number, names: unknown) => resolveDownloadChoice(id, Array.isArray(names) ? names.map(String) : null));
  handle("game:syncSaves", (id: number) => syncNow(id, emit));
  handle("saves:resolveConflicts", (requestId: string, answers: Record<string, "local" | "remote" | "skip"> | null) => resolveConflicts(String(requestId), answers));
  handle("saves:syncAll", (ids?: string[]) => syncAllFolders(emit, Array.isArray(ids) ? ids : loadConfig().webdavSyncEmulators));
  handle("saves:syncTargets", () => loadConfig().emulators
    .map((e) => ({ id: e.id, name: e.name, folders: syncFoldersOf(e).filter((f) => f.enabled).map((f) => f.name) }))
    .filter((e) => e.folders.length));
  // The normal close: the save sync before closing still runs, and full screen stays remembered.
  handle("window:close", () => { win?.close(); return true; });
  handle("window:setFullscreen", (on: boolean) => {
    win?.setFullScreen(!!on);
    updateConfig({ fullscreen: !!on });
    return !!on;
  });
  handle("app:quitNow", () => {
    quitting = true;
    win?.close();
  });
  // custom: added by hand (not one of the catalog defaults), so it can be removed again.
  handle("saves:folders", () => Object.fromEntries(loadConfig().emulators.map((e) => {
    const defaults = new Set((presetOf(e)?.saveFolders ?? []).map((d) => d.name));
    return [e.id, syncFoldersOf(e).map((f) => ({ ...f, local: localPathOf(e, f), exists: existsSync(localPathOf(e, f)), custom: !defaults.has(f.name) }))];
  })));
  handle("saves:testWebdav", async () => {
    const { dav, base } = webdavClient();
    await dav.check(base);
    return true;
  });
  handle("game:uninstall", (id: number) => uninstall(id));
  handle("game:cancel", (id: number) => cancel(id));
  handle("game:setLaunchFile", (id: number, rel: string) => setLaunchFile(id, rel));
  handle("game:openFolder", (id: number) => {
    const game = getInstalled(id);
    if (game) shell.openPath(game.dir);
  });
  handle("installed:list", () => listInstalled());
  handle("installed:verify", () => verifyDownloads());
  handle("update:check", () => checkForUpdate());
  handle("update:install", (update: UpdateInfo) =>
    installUpdate(update, (received, total) => {
      if (win && !win.isDestroyed()) win.webContents.send("update-progress", { received, total });
    }),
  );
  handle("connection:status", () => !isOffline());
  handle("connection:check", async () => {
    const online = await checkServer();
    // Left over from an earlier run spent offline.
    if (online) {
      void syncPendingSaves();
      void flushSessions();
    }
    return online;
  });
  handle("running:list", () => runningGames());

  handle("emulators:presets", () => ({ presets: PRESETS, defaultCores: DEFAULT_CORES }));
  const emuProgress = (event: unknown) => {
    if (win && !win.isDestroyed()) win.webContents.send("emu-progress", event);
  };
  handle("emulators:install", (key: string, libraryPlatforms: string[]) => installEmulator(key, Array.isArray(libraryPlatforms) ? libraryPlatforms : [], emuProgress));
  handle("emulators:checkUpdates", () => checkEmulatorUpdates());
  handle("emulators:installCores", (cores: string[], emulatorId?: string) => installCores(Array.isArray(cores) ? cores : [], emuProgress, typeof emulatorId === "string" ? emulatorId : undefined));
  handle("emulators:openFolder", (key: string) => shell.openPath(managedFolder(String(key))));
  handle("emulators:adopt", (id: string, channelKey?: string) => adoptEmulator(String(id), typeof channelKey === "string" ? channelKey : undefined));
  handle("emulators:release", (id: string) => releaseEmulator(String(id)));
  handle("emulators:detectRetroArch", () => { const p = detectRetroArch(); return p ? toStored(p) : null; });
  handle("emulators:cores", (path: string) => listCores(resolvePath(path)));
  handle("emulators:open", (id: string) => openEmulator(String(id)));
  handle("emulators:exists", (path: string) => !!path && existsSync(resolvePath(path)));
  handle("app:info", () => ({ version: app.getVersion(), project: "https://github.com/housello/romm-launcher" }));
  handle("app:paths",() => ({ portable: isPortable(), baseDir: baseDir(), dataDir: dataDir(), canSwitch: canSwitchLocation(), ...dataLocations() }));
  handle("app:setDataLocation", (toLocal: boolean) => switchDataLocation(!!toLocal));

  handle("dialog:pickExe", async () => {
    const result = await dialog.showOpenDialog(win!, {
      properties: ["openFile"],
      filters: [{ name: "Programs", extensions: ["exe", "bat", "cmd"] }, { name: "All files", extensions: ["*"] }],
      ...browseStart(),
    });
    // Inside the launcher's folder (portable), the path is stored relative to it.
    return result.canceled ? null : toStored(result.filePaths[0] ?? "") || null;
  });
  // A game's manuals, guides, soundtracks, screenshots and videos (media.ts).
  handle("media:open", (romId: number, key: string) => openMedia(Number(romId), String(key)));
  handle("media:save", async (romId: number, key: string, name: string) => {
    const result = await dialog.showSaveDialog(win!, { defaultPath: join(app.getPath("downloads"), String(name ?? "file").replace(/[<>:"/\\|?*]/g, "_")) });
    if (result.canceled || !result.filePath) return false;
    await saveMedia(Number(romId), String(key), result.filePath);
    return true;
  });
  handle("media:folder", async (romId: number) => shell.openPath(await mediaFolder(Number(romId))));
  handle("dialog:pickFolder", async () => {
    const result = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"], ...browseStart() });
    return result.canceled ? null : toStored(result.filePaths[0] ?? "") || null;
  });

  handle("dialog:pickSaveFolder", async (emulatorId: string) => {
    const emulator = loadConfig().emulators.find((e) => e.id === emulatorId);
    if (!emulator) return null;
    const result = await dialog.showOpenDialog(win!, { properties: ["openDirectory"], defaultPath: dirname(resolvePath(emulator.path)) });
    const picked = result.canceled ? "" : result.filePaths[0] ?? "";
    return picked ? storedFolderPath(emulator, picked) : null;
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

  // ---- Tools: rename games from a MAME XML / DAT
  const toolProgress = (label: string, fraction: number) => {
    if (win && !win.isDestroyed()) win.webContents.send("tool-progress", { label, fraction });
  };
  handle("tools:pickMameXml", async () => {
    const result = await dialog.showOpenDialog(win!, {
      title: "Choose a MAME XML or DAT",
      properties: ["openFile"],
      filters: [{ name: "MAME XML / DAT", extensions: ["xml", "dat"] }, { name: "All files", extensions: ["*"] }],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle("tools:mamePlan", (platformId: number, xmlPath: string, clean: boolean, tags: unknown) => {
    const groups = (Array.isArray(tags) ? tags : []).filter((t): t is "kind" | "mechanical" | "status" => t === "kind" || t === "mechanical" || t === "status");
    return buildPlan(platformId, xmlPath, { clean, tags: groups }, toolProgress);
  });
  handle("tools:mameApply", (rows: Array<{ id: number; current: string; proposed: string }>) => {
    const clean = rows
      .filter((r) => Number.isInteger(r.id) && typeof r.proposed === "string" && r.proposed.trim())
      .map((r) => ({ id: r.id, current: String(r.current ?? ""), proposed: r.proposed.trim() }));
    return applyRenames(loadConfig().serverUrl, clean, toolProgress);
  });
  handle("tools:mameUndoInfo", () => undoInfo());
  handle("tools:arcadeDb", (games: unknown, options: unknown) => {
    const list = (Array.isArray(games) ? games : []).filter((g: any) => Number.isInteger(g?.id) && typeof g?.set === "string").map((g: any) => ({ id: g.id, set: g.set }));
    const o = (options ?? {}) as Partial<AdbOptions>;
    const covers = ["flyer", "title", "ingame", "cabinet", "marquee", "box", "logo"];
    const shots = ["ingame", "title", "select", "versus", "boss", "gameover", "end", "score", "howto"];
    return applyArcadeDb(list, {
      details: !!o.details,
      history: !!o.history,
      cover: covers.includes(String(o.cover)) ? (o.cover as AdbOptions["cover"]) : null,
      screenshots: (Array.isArray(o.screenshots) ? o.screenshots : []).filter((s) => shots.includes(String(s))) as AdbOptions["screenshots"],
      manual: !!o.manual,
    }, toolProgress);
  });
  handle("tools:mameExes", () => mameExes());
  handle("tools:mameListXml", (id: string) => listXmlFromExe(String(id), toolProgress));
  handle("tools:softwareLists", async (id: string, slugs: string[]) => {
    const lists = await softwareLists(String(id));
    return { lists, guess: guessList(Array.isArray(slugs) ? slugs.map(String) : [], lists) };
  });
  handle("tools:mameUndo", () => undoLast(loadConfig().serverUrl, toolProgress));
  handle("open:external", (url: string) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
}

/** Light, dark or follow Windows; the page's colours follow via prefers-color-scheme. */
function applyTheme(): void {
  const theme = loadConfig().theme;
  nativeTheme.themeSource = theme === "light" || theme === "dark" ? theme : "system";
}

/** A validated emulator choice from the renderer, or null. */
function gameChoice(value: unknown): GameEmulator | null {
  const v = value as { emulatorId?: unknown; core?: unknown } | null | undefined;
  if (!v || typeof v.emulatorId !== "string" || !loadConfig().emulators.some((e) => e.id === v.emulatorId)) return null;
  return { emulatorId: v.emulatorId, ...(typeof v.core === "string" && /^[\w.-]+$/.test(v.core) ? { core: v.core } : {}) };
}

/** A downloaded game's detail panel from its local record, for when RomM is unreachable. */
function offlineDetail(id: number) {
  const game = getInstalled(id);
  if (!game) throw new LaunchError("RomM cannot be reached, and this game is not downloaded.", "offline");
  const meta = game.meta;
  const resolved = resolveEmulator([game.platformSlug], id);
  const platformOnly = resolveEmulator([game.platformSlug]);
  return {
    id,
    offline: true,
    name: game.name,
    fsName: game.launchFile,
    summary: meta?.summary ?? "",
    platformSlug: game.platformSlug,
    platformName: game.platformName,
    cover: meta?.cover || game.coverPath,
    coverUrl: game.coverUrl ?? null,
    screenshots: [],
    sizeBytes: game.sizeBytes,
    files: [],
    regions: meta?.regions ?? [],
    languages: meta?.languages ?? [],
    genres: meta?.genres ?? [],
    companies: meta?.companies ?? [],
    year: meta?.year ?? null,
    emulator: resolved ? resolved.emulator.name + (resolved.mapping.core ? ` (${resolved.mapping.core})` : "") : null,
    emulatorId: resolved?.emulator.id ?? null,
    emulatorCore: resolved?.mapping.core ?? null,
    perGameEmulator: !!resolved?.perGame,
    platformEmulator: platformOnly ? platformOnly.emulator.name + (platformOnly.mapping.core ? ` (${platformOnly.mapping.core})` : "") : null,
    installed: game,
    versions: [],
    running: runningGames().includes(id),
    webUrl: `${loadConfig().serverUrl}/rom/${id}`,
    collections: [],
    saveMode: resolved ? saveModeOf(resolved.emulator) : "off",
    syncSaves: loadConfig().syncSaves,
    saves: [],
    states: [],
  };
}

/** Upload the saves of games played while RomM was unreachable. */
async function syncPendingSaves(): Promise<void> {
  for (const game of listInstalled().filter((g) => g.savesPending)) {
    try {
      const message = await syncNow(game.romId, emit);
      const current = getInstalled(game.romId);
      if (current) putInstalled({ ...current, savesPending: false });
      emit({ romId: game.romId, type: "notice", message: `${game.name}: ${message}`, level: "ok" });
    } catch (error) {
      if (isUnreachable(error)) return;
      console.error(`[saves] pending sync of ${game.romId}`, error);
    }
  }
}

app.whenReady().then(() => {
  applyTheme();
  registerImageProtocol();
  registerIpc();
  createWindow();
  void cleanUpUpdate();
  onConnectionChange((online) => {
    if (win && !win.isDestroyed()) win.webContents.send("connection", online);
    if (online) {
      void syncPendingSaves();
      void flushSessions();
    }
  });
});

app.on("window-all-closed", () => app.quit());
