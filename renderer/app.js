"use strict";
/* global romm */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const api = (channel, ...args) => window.romm.invoke(channel, ...args);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/**
 * Image address for the proxy: the RomM server path first, then the external URL
 * (url_cover), which is what RomM's web interface falls back to as well.
 */
const img = (path, external) => {
  let server = "";
  let other = /^https?:\/\//i.test(external || "") ? external : "";
  if (path && /^https?:/i.test(path)) {
    let u;
    try { u = new URL(path); } catch { u = null; }
    let origin = "";
    try { origin = new URL(state.config?.serverUrl || "").origin; } catch { /* not configured */ }
    if (u && u.origin === origin) server = u.pathname + u.search;
    else if (u && !other) other = u.href;
  } else if (path && path.startsWith("/")) {
    server = path;
  }
  if (!server && !other) return null;
  const q = new URLSearchParams();
  if (server) q.set("s", server);
  if (other) q.set("u", other);
  return "romm-img://img/?" + q.toString();
};
const fmtBytes = (n) => {
  if (!n) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};

function toast(message, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), kind === "error" ? 7000 : 3500);
}

// ------------------------------------------------------------------ state

const state = {
  config: null,
  platforms: [],
  collections: [],
  view: { kind: "all", title: "All games" },
  search: "",
  sort: "name:asc",
  offset: 0,
  total: 0,
  loading: false,
  done: false,
  gen: 0,
  jobs: new Map(), // romId -> { type, label, received, total }
  detailId: null,
};

// ------------------------------------------------------------------ sidebar

async function loadSidebar() {
  try {
    const [platforms, collections] = await Promise.all([api("platforms:list"), api("collections:list").catch(() => [])]);
    state.platforms = platforms;
    state.collections = collections;
  } catch (error) {
    $("#platforms").innerHTML = `<div class="muted pad">${esc(error.message)}</div>`;
    return;
  }
  const mapped = state.config.platforms || {};
  $("#platforms").innerHTML = state.platforms.map((p) => `
    <a class="nav-item" data-platform="${p.id}" title="${esc(p.slug)}">
      <span class="name">${esc(p.name)}</span>
      ${mapped[p.slug]?.emulatorId || mapped[p.fsSlug]?.emulatorId ? "" : '<span class="warn" title="No emulator set">●</span>'}
      <span class="count">${p.romCount}</span>
    </a>`).join("") || '<div class="muted pad">No platforms</div>';
  markActive();
}

function markActive() {
  $$(".nav-item").forEach((a) => a.classList.remove("active"));
  const v = state.view;
  const sel = v.kind === "platform" ? `[data-platform="${v.id}"]` : v.kind === "collection" ? `[data-view="collections"]` : `[data-view="${v.kind}"]`;
  $(sel)?.classList.add("active");
  $$("#menubar a").forEach((a) => a.classList.toggle("active", a.dataset.menu === v.kind));
}

$("#sidebar").addEventListener("click", (e) => {
  const a = e.target.closest(".nav-item");
  if (!a) return;
  if (a.dataset.view) setView({ kind: a.dataset.view, title: a.textContent.trim() });
  if (a.dataset.platform) {
    const p = state.platforms.find((x) => x.id === Number(a.dataset.platform));
    setView({ kind: "platform", id: p.id, title: p.name, slug: p.slug });
  }
  if (a.dataset.collection) {
    const c = state.collections.find((x) => !x.smart && x.id === Number(a.dataset.collection));
    setView({ kind: "collection", id: c.id, title: c.name });
  }
});

// ------------------------------------------------------------------ grid

// ------------------------------------------------------------------ offline

/** Switch between the live library and the downloaded games, as RomM comes and goes. */
// ------------------------------------------------------------------ signed-in user

const user = { name: null };

/** The RomM account in the menu bar; offline, the one the settings sign in with. */
function renderUser() {
  const name = user.name || state.config?.username || "";
  const el = $("#menu-user");
  el.hidden = !name;
  el.textContent = name ? `👤 ${name}${state.online === false ? " · offline" : ""}` : "";
}

async function refreshUser() {
  try {
    user.name = (await api("user:me")).username || null;
  } catch {
    // Offline or refused: keep showing the last known name.
  }
  renderUser();
}

function setOnline(online) {
  if (state.online === online) return;
  state.online = online;
  $("#offline-banner").hidden = online;
  if (online) void refreshUser();
  else renderUser();
  if (online) {
    toast("RomM is reachable again", "ok");
    loadSidebar();
    if (state.view.kind === "installed") reload();
  } else if (!["installed", "settings", "about"].includes(state.view.kind)) {
    setView({ kind: "installed", title: "Downloaded" });
  }
}

window.romm.onConnection((online) => setOnline(online));

$("#offline-retry").addEventListener("click", async () => {
  const button = $("#offline-retry");
  button.disabled = true;
  try {
    if (!(await api("connection:check"))) toast("RomM still cannot be reached", "error");
  } finally {
    button.disabled = false;
  }
});

// ------------------------------------------------------------------ updates

/**
 * Look for a newer launcher; `quiet` shows nothing when there is none or GitHub fails.
 * Returns the update, null when up to date, or the error message.
 */
async function checkUpdates(quiet) {
  let update;
  try {
    update = await api("update:check");
  } catch (error) {
    if (!quiet) toast(`Could not check for updates: ${error.message}`, "error");
    return error.message;
  }
  if (!update) {
    if (!quiet) toast(`RomM Launcher is up to date`, "ok");
    return null;
  }
  showUpdate(update);
  return update;
}

// ------------------------------------------------------------------ about

const about = { launcher: "", emulators: "" };

function openAbout() {
  closeDetail();
  state.view = { kind: "about" };
  markActive();
  $("#content").hidden = true;
  $("#toolbar").hidden = true;
  $("#filter-panel").hidden = true;
  $("#settings").hidden = true;
  $("#about").hidden = false;
  renderAbout();
}

async function renderAbout() {
  const info = await api("app:info");
  presets ??= await api("emulators:presets");
  state.config = await api("config:get");
  if (state.view.kind !== "about") return;
  const managed = state.config.emulators.filter((e) => e.managed);
  const rows = managed.map((e) => {
    const key = e.managed.key;
    const update = emuCatalog.updates[key];
    const busy = emuCatalog.busy.get(key);
    return `<div><span>${esc(e.name)} <span class="muted">${esc(e.managed.version)}</span></span>
      <span data-emu-status="${key}">${busy ? esc(busy)
        : update?.version ? `<b>${esc(update.version)} available</b> <button class="primary" data-about-update="${key}">Update</button>`
        : update?.error ? `<span class="muted" title="${esc(update.error)}">check failed</span>` : ""}</span></div>`;
  });
  $("#about").innerHTML = `
    <h1 style="margin-top:0">RomM Launcher <span class="muted" style="font-weight:400">${esc(info.version)}</span></h1>
    <div class="hint" style="max-width:760px">A Windows client for a <a data-ext="https://github.com/rommapp/romm">RomM</a> server that plays your library in local emulators.
      Not affiliated with the RomM project. License AGPL-3.0. <a data-ext="${esc(info.project)}">Project page</a> · <a data-ext="${esc(info.project)}/releases">Release notes</a></div>

    <h2>Launcher updates</h2>
    <div class="form">
      <label>Version</label><div class="row"><span>${esc(info.version)}</span><span class="muted" id="about-launcher">${esc(about.launcher)}</span><div class="spacer"></div><button id="about-check">Check now</button></div>
      <label></label><label><input type="checkbox" id="about-auto" ${state.config.checkUpdates !== false ? "checked" : ""}> Look for a new version at start (asks GitHub)</label>
    </div>

    <h2>Emulator updates</h2>
    ${managed.length ? `<div class="row" style="margin-bottom:8px"><span class="muted" id="about-emus">${esc(about.emulators)}</span><div class="spacer"></div><button id="about-check-emus">Check emulator updates</button></div>
      <div class="files" style="font-family:inherit;font-size:14px;max-width:760px">${rows.join("")}</div>`
      : '<div class="muted">No emulator was downloaded by the launcher. Add one in Settings → Emulators and choose Download.</div>'}`;
}

$("#about").addEventListener("click", async (e) => {
  const ext = e.target.closest("[data-ext]")?.dataset.ext;
  if (ext) return api("open:external", ext);
  if (e.target.id === "about-check") {
    e.target.disabled = true;
    about.launcher = "Checking…";
    $("#about-launcher").textContent = about.launcher;
    const result = await checkUpdates(true);
    about.launcher = result === null ? "Up to date" : typeof result === "string" ? `Check failed: ${result}` : `${result.version} available, see the banner above`;
    return renderAbout();
  }
  if (e.target.id === "about-check-emus") {
    e.target.disabled = true;
    about.emulators = "Checking…";
    $("#about-emus").textContent = about.emulators;
    try {
      const keys = await checkEmulatorUpdates();
      about.emulators = keys.length ? `${keys.length} update${keys.length === 1 ? "" : "s"} available` : "All up to date";
    } catch (error) {
      about.emulators = `Check failed: ${error.message}`;
    }
    return renderAbout();
  }
  const update = e.target.closest("[data-about-update]")?.dataset.aboutUpdate;
  if (update) return installFromCatalog(update);
});

$("#about").addEventListener("change", async (e) => {
  if (e.target.id === "about-auto") await save({ checkUpdates: e.target.checked }, true);
});

$("#menubar").addEventListener("click", (e) => {
  const item = e.target.closest("[data-menu]")?.dataset.menu;
  if (item === "settings") openSettings();
  if (item === "about") openAbout();
  if (item === "user") openSettings("server");
});

function showUpdate(update) {
  const banner = $("#update-banner");
  banner.hidden = false;
  banner.innerHTML = `<span>RomM Launcher ${esc(update.version)} is available (you have ${esc(update.current)}).</span>
    ${update.canInstall ? '<button class="primary" data-up="install">Update and restart</button>' : ""}
    <button data-up="notes">${update.canInstall ? "What's new" : "Download"}</button>
    <button data-up="later">Later</button>`;
  banner.onclick = async (e) => {
    const act = e.target.closest("[data-up]")?.dataset.up;
    if (act === "later") banner.hidden = true;
    if (act === "notes") api("open:external", update.notesUrl);
    if (act !== "install") return;
    if (state.jobs.size || (await api("running:list")).length) {
      toast("Wait for downloads and running games to finish first", "error");
      return;
    }
    banner.innerHTML = `<span id="update-status">Downloading RomM Launcher ${esc(update.version)}…</span>`;
    const stop = window.romm.onUpdateProgress(({ received, total }) => {
      $("#update-status").textContent = `Downloading RomM Launcher ${update.version}… ${fmtBytes(received)}${total ? " / " + fmtBytes(total) : ""}`;
    });
    try {
      // On success the launcher closes and the new one starts.
      await api("update:install", update);
    } catch (error) {
      stop();
      toast(`Update failed: ${error.message}`, "error");
      showUpdate(update);
    }
  };
}

function setView(view, search = "") {
  if (state.online === false && view.kind !== "installed") {
    toast("Offline: only downloaded games are available until RomM is reachable", "");
    view = { kind: "installed", title: "Downloaded" };
    search = "";
  }
  state.view = view;
  // Each view starts unfiltered, unless the sidebar search sent us here.
  state.search = search;
  $("#view-search").value = search;
  if (view.kind !== "all") $("#search").value = "";
  $("#view-search").placeholder = `Search in ${view.title}…`;
  $("#settings").hidden = true;
  $("#about").hidden = true;
  $("#content").hidden = false;
  $("#toolbar").hidden = false;
  $("#view-title").textContent = view.title;
  markActive();
  applyViewMode();
  reload();
  if (!$("#filter-panel").hidden) toggleFilterPanel(true);
}

function reload() {
  state.gen++;
  // A request from the previous view may still be in flight; it is ignored when it
  // lands (its gen no longer matches), so it must not keep this view from loading.
  state.loading = false;
  state.offset = 0;
  state.done = false;
  state.error = null;
  state.total = 0;
  state.shown = 0;
  // "Favourites first": part 0 = favourites, part 1 = everything else.
  state.phase = 0;
  state.phaseOffset = 0;
  state.favTotal = undefined;
  state.restTotal = undefined;
  state.seen = new Set(); // ids already shown, including folded versions
  state.items = new Map(); // id -> list item, for the version chooser
  $("#grid").innerHTML = "";
  $("#empty").hidden = true;
  $("#view-count").textContent = "";
  $("#content").scrollTop = 0;
  renderListFoot();
  const isCollections = state.view.kind === "collections";
  $("#filter-btn").hidden = isCollections;
  $("#sort").hidden = isCollections;
  if (isCollections) {
    $("#filter-panel").hidden = true;
    return renderCollectionsPage();
  }
  if (state.view.kind === "installed") return renderInstalled();
  loadMore();
}

async function loadMore() {
  if (state.loading || state.done || state.view.kind === "installed" || state.view.kind === "collections") return;
  state.loading = true;
  state.error = null;
  const gen = state.gen;
  // RomM cannot sort by favourite, so "Favourites first" loads two filtered parts in a row
  // (unless a favourite filter is already set, which makes it a single part).
  const favFirst = state.sort === "favorite:first" && state.filters.flags.favorite === undefined;
  const [orderBy, orderDir] = state.sort === "favorite:first" ? ["name", "asc"] : state.sort.split(":");
  const base = activeFilters();
  const partFilters = (fav) => ({ flags: { ...base.flags, favorite: fav }, lists: base.lists });
  const params = {
    offset: favFirst ? state.phaseOffset : state.offset,
    limit: state.config.pageSize || 60,
    search: state.search,
    orderBy,
    orderDir,
    filters: favFirst ? partFilters(state.phase === 0) : base,
  };
  if (state.view.kind === "platform") params.platformId = state.view.id;
  if (state.view.kind === "collection") params[state.view.smart ? "smartCollectionId" : "collectionId"] = state.view.id;
  const firstPage = state.offset === 0;
  if (firstPage) showLoading();
  renderListFoot();
  try {
    const page = await api("roms:list", params);
    if (gen !== state.gen) return;
    if (firstPage) $("#empty").hidden = true;
    if (favFirst) {
      if (state.phase === 0 && state.phaseOffset === 0) {
        state.favTotal = page.total;
        // The size of the second part, so the count covers the whole view from the start.
        const rest = await api("roms:list", { ...params, offset: 0, limit: 1, filters: partFilters(false) });
        if (gen !== state.gen) return;
        state.restTotal = rest.total;
        if (!state.favTotal) {
          // Favourites belong to a RomM user: say which one, so an empty result is not a mystery.
          const who = state.config.authType === "basic" && state.config.username ? `RomM user “${state.config.username}”` : "this RomM account";
          toast(`No favourites here for ${who}. Star games with ☆ Favourite, or sign in as the user whose favourites you want (Settings → Server).`);
        }
      }
      state.total = (state.favTotal ?? 0) + (state.restTotal ?? 0);
      state.phaseOffset += page.items.length;
      state.offset += page.items.length;
      const partDone = page.items.length === 0 || state.phaseOffset >= page.total;
      if (partDone && state.phase === 0 && state.restTotal) {
        state.phase = 1;
        state.phaseOffset = 0;
      } else if (partDone) {
        state.done = true;
      }
    } else {
      state.total = page.total;
      state.offset += page.items.length;
      state.done = page.items.length === 0 || state.offset >= page.total;
    }
    // Fold versions client-side too, for servers that ignore group_by_meta_id.
    const fresh = page.items.filter((item) => {
      if (state.seen.has(item.id)) return false;
      state.seen.add(item.id);
      for (const v of item.versions) state.seen.add(v.id);
      state.items.set(item.id, item);
      return true;
    });
    state.shown += fresh.length;
    $("#grid").insertAdjacentHTML("beforeend", fresh.map(cardHtml).join(""));
    $("#view-count").textContent = `${state.total} games`;
    if (state.done && state.offset === 0) showEmpty(state.search || activeFilterCount() ? "No games match your search and filters." : "Nothing here.");
  } catch (error) {
    if (gen !== state.gen) return;
    if (firstPage) {
      state.done = true;
      showEmpty(error.message, true, true);
    } else {
      // Not "done": the footer shows the error with a Retry button.
      state.error = error.message;
    }
  } finally {
    if (gen === state.gen) {
      state.loading = false;
      renderListFoot();
    }
  }
  // The new page may not fill the screen (or the user kept scrolling meanwhile).
  if (gen === state.gen && !state.error) setTimeout(maybeLoadMore, 0); // not rAF: paused while the window is hidden
}

/** Load the next page when the end of the list is near. One measure, checked on every scroll. */
function maybeLoadMore() {
  if (state.loading || state.done || state.error || state.view.kind === "installed" || state.view.kind === "collections" || $("#content").hidden) return;
  const c = $("#content");
  if (c.scrollHeight - c.scrollTop - c.clientHeight < 1200) loadMore();
}

let scrollQueued = false;
$("#content").addEventListener("scroll", () => {
  if (scrollQueued) return;
  scrollQueued = true;
  setTimeout(() => {
    scrollQueued = false;
    maybeLoadMore();
  });
}, { passive: true });
window.addEventListener("resize", () => maybeLoadMore());

/** Footer under the grid: progress, a manual "Load more", and errors with Retry. */
function renderListFoot() {
  const foot = $("#list-foot");
  if (!foot) return;
  if (state.view.kind === "installed" || state.view.kind === "collections" || state.offset === 0 && !state.loading) {
    foot.innerHTML = "";
    return;
  }
  const counted = state.total ? `Loaded ${Math.min(state.offset, state.total).toLocaleString()} of ${state.total.toLocaleString()}` : "";
  if (state.loading && state.offset > 0) foot.innerHTML = `<span class="muted">${counted} · Loading…</span>`;
  else if (state.error) foot.innerHTML = `<span style="color:var(--danger)">Could not load more games: ${esc(state.error)}</span> <button id="foot-retry">Retry</button>`;
  else if (!state.done) foot.innerHTML = `<span class="muted">${counted}</span> <button id="foot-more">Load more</button>`;
  else foot.innerHTML = state.total > state.config.pageSize ? `<span class="muted">All ${state.total.toLocaleString()} games loaded</span>` : "";
  $("#foot-retry")?.addEventListener("click", () => { state.error = null; loadMore(); });
  $("#foot-more")?.addEventListener("click", () => loadMore());
}

function showEmpty(message, withSettings, withRetry) {
  $("#empty").hidden = false;
  $("#empty").innerHTML = `<p>${esc(message)}</p>
    ${withRetry ? '<button class="primary" id="retry">Retry</button> ' : ""}${withSettings ? '<button id="go-settings">Open settings</button>' : ""}`;
  $("#go-settings")?.addEventListener("click", () => openSettings());
  $("#retry")?.addEventListener("click", () => reload());
}

function showLoading() {
  $("#empty").hidden = false;
  $("#empty").innerHTML = '<p class="muted">Loading…</p>';
}

async function renderInstalled() {
  const games = await api("installed:list");
  const q = state.search.toLowerCase();
  const list = games.filter((g) => !q || g.name.toLowerCase().includes(q));
  $("#grid").innerHTML = list.map((g) => cardHtml({ id: g.romId, name: g.name, platformName: g.platformName, cover: g.coverPath, coverUrl: g.coverUrl, installed: true, sizeBytes: g.sizeBytes })).join("");
  $("#view-count").textContent = `${list.length} games · ${fmtBytes(list.reduce((s, g) => s + g.sizeBytes, 0))}`;
  if (!list.length) showEmpty("No downloaded games yet. Press Play on any game to download and start it.");
}

function cardHtml(r) {
  const src = img(r.cover, r.coverUrl);
  const job = state.jobs.get(r.id);
  const pct = job && job.total ? Math.round((job.received / job.total) * 100) : 0;
  return `
  <div class="card" data-id="${r.id}">
    <div class="cover">${src ? `<img loading="lazy" src="${esc(src)}" alt="">` : ""}<span>${src ? "" : esc(r.name)}</span></div>
    ${r.installed || r.versions?.some((v) => v.installed) ? '<span class="badge" title="Downloaded">✓</span>' : ""}
    ${r.versions?.length > 1 ? `<span class="vbadge" title="${esc(r.versions.map((v) => v.fileName).join("\n"))}">${r.versions.length} versions</span>` : ""}
    <button class="play-btn" data-play="${r.id}" title="Play">▶</button>
    ${job && job.type === "progress" ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ""}
    <div class="title" title="${esc(r.name)}">${esc(r.name)}</div>
    <div class="sub">${esc(r.platformName || "")}${r.year ? " · " + r.year : ""}</div>
  </div>`;
}

$("#grid").addEventListener("click", (e) => {
  if (state.view.kind === "collections") return collectionsPageClick(e);
  const play = e.target.closest("[data-play]");
  if (play) {
    e.stopPropagation();
    const item = state.items?.get(Number(play.dataset.play));
    if (item?.versions?.length > 1) {
      const last = lastVersionOf(item.versions);
      if (last) return playGame(last);
      return chooseVersion(item, "Play").then((id) => id && playVersion(item.versions, id));
    }
    return playGame(Number(play.dataset.play));
  }
  const card = e.target.closest(".card");
  if (card) {
    const item = state.items?.get(Number(card.dataset.id));
    openDetail((item?.versions?.length > 1 && lastVersionOf(item.versions)) || Number(card.dataset.id));
  }
});

let searchTimer = 0;
// Sidebar box: searches the whole library.
$("#search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const term = $("#search").value;
    if (state.view.kind !== "all") setView({ kind: "all", title: "All games" }, term);
    else { state.search = term; $("#view-search").value = term; reload(); }
  }, 300);
});
// Toolbar box: searches inside the current platform / collection / view.
$("#view-search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = $("#view-search").value;
    if (state.view.kind === "all") $("#search").value = state.search;
    reload();
  }, 300);
});
$("#sort").addEventListener("change", () => {
  state.sort = $("#sort").value;
  reload();
  api("config:set", { sort: state.sort }).then((c) => { state.config = c; }).catch(() => {});
});
/** Covers or the details list; the collections page always shows covers. */
function applyViewMode() {
  const list = state.config?.viewMode === "list";
  $("#grid").classList.toggle("list", list && state.view.kind !== "collections");
  $("#zoom").hidden = list;
  $$(".viewmode button").forEach((b) => b.classList.toggle("active", b.dataset.mode === (list ? "list" : "grid")));
}

$(".viewmode").addEventListener("click", async (e) => {
  const mode = e.target.closest("[data-mode]")?.dataset.mode;
  if (!mode) return;
  state.config = { ...state.config, viewMode: mode };
  applyViewMode();
  state.config = await api("config:set", { viewMode: mode });
});

$("#zoom").addEventListener("input", () => {
  document.documentElement.style.setProperty("--card", $("#zoom").value + "px");
  maybeLoadMore();
});
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    // Ctrl+F searches the current view; Ctrl+Shift+F the whole library.
    const box = e.shiftKey || !$("#settings").hidden ? $("#search") : $("#view-search");
    box.focus();
    box.select();
  }
  if (e.key === "Escape") closeDetail();
});

// ------------------------------------------------------------------ filters (RomM server-side)

const FLAG_FILTERS = [
  ["favorite", "Favourites"], ["matched", "Matched to metadata"], ["last_played", "Played"],
  ["has_saves", "Has saves"], ["has_states", "Has save states"], ["has_ra", "RetroAchievements"],
  ["duplicate", "Duplicates"], ["verified", "Verified"], ["missing", "Missing files"],
];
const LIST_FILTERS = [
  ["genres", "Genres"], ["franchises", "Franchises"], ["collections", "Series"], ["companies", "Companies"],
  ["developers", "Developers"], ["publishers", "Publishers"], ["player_counts", "Players"],
  ["age_ratings", "Age ratings"], ["regions", "Regions"], ["languages", "Languages"], ["statuses", "My status"], ["tags", "Tags"],
];
const STATUS_LABELS = { incomplete: "Incomplete", finished: "Finished", completed_100: "Completed 100%", retired: "Retired", never_playing: "Never playing" };

state.filters = { flags: {}, lists: {} };
const filterValueCache = new Map();

function activeFilters() {
  return state.filters;
}
function activeFilterCount() {
  return Object.values(state.filters.flags).filter((v) => v === true || v === false).length
    + Object.values(state.filters.lists).reduce((n, l) => n + l.length, 0);
}
function updateFilterButton() {
  const n = activeFilterCount();
  $("#filter-count").hidden = n === 0;
  $("#filter-count").textContent = n;
  $("#filter-btn").classList.toggle("on", n > 0);
}

let filterTimer = 0;
function filtersChanged() {
  updateFilterButton();
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => { if (state.view.kind !== "installed") reload(); }, 350);
}

async function filterValuesForView() {
  const v = state.view;
  const key = `${v.kind}:${v.smart ? "smart:" : ""}${v.id ?? ""}`;
  if (!filterValueCache.has(key)) {
    const params = {};
    if (v.kind === "platform") params.platformId = v.id;
    if (v.kind === "collection") params[v.smart ? "smartCollectionId" : "collectionId"] = v.id;
    filterValueCache.set(key, api("roms:filterValues", params).catch((e) => { filterValueCache.delete(key); throw e; }));
  }
  const values = { ...(await filterValueCache.get(key)) };
  values.statuses = Object.keys(STATUS_LABELS);
  return values;
}

async function toggleFilterPanel(force) {
  const panel = $("#filter-panel");
  const open = force ?? panel.hidden;
  panel.hidden = !open;
  if (!open) return;
  if (state.view.kind === "installed") {
    panel.innerHTML = '<div class="muted">Filters apply to your RomM library; the Downloaded view only searches by name.</div>';
    return;
  }
  panel.innerHTML = '<div class="muted">Loading filters…</div>';
  try {
    renderFilterPanel(await filterValuesForView());
  } catch (error) {
    panel.innerHTML = `<div style="color:var(--danger)">${esc(error.message)}</div>`;
  }
}

function renderFilterPanel(values) {
  const f = state.filters;
  const label = (key, v) => (key === "statuses" ? STATUS_LABELS[v] ?? v : v);
  $("#filter-panel").innerHTML = `
    <div class="fp-head">
      <b>Filters</b><span class="muted">Applied by your RomM server to this view</span><div class="spacer"></div>
      <button id="fp-clear" ${activeFilterCount() ? "" : "disabled"}>Clear all</button><button id="fp-close" title="Close">✕</button>
    </div>
    <div class="fp-flags">${FLAG_FILTERS.map(([k, l]) => `
      <label>${esc(l)}<select data-flag="${k}">
        <option value="">Any</option><option value="true" ${f.flags[k] === true ? "selected" : ""}>Yes</option><option value="false" ${f.flags[k] === false ? "selected" : ""}>No</option>
      </select></label>`).join("")}</div>
    <div class="fp-lists">${LIST_FILTERS.map(([k, l]) => {
      const selected = f.lists[k] ?? [];
      const opts = [...new Set([...selected, ...(values[k] ?? [])])];
      if (!opts.length) return "";
      return `<details data-list="${k}" ${selected.length ? "open" : ""}>
        <summary>${esc(l)} <span class="muted">${selected.length ? `(${selected.length} selected)` : `(${opts.length})`}</span></summary>
        ${opts.length > 8 ? '<input type="search" class="fp-search" placeholder="Find…">' : ""}
        <div class="opts">${opts.map((v) => `<label data-v="${esc(String(v).toLowerCase())}"><input type="checkbox" value="${esc(v)}" ${selected.includes(v) ? "checked" : ""}> ${esc(label(k, v))}</label>`).join("")}</div>
      </details>`;
    }).join("")}</div>`;
}

$("#filter-panel").addEventListener("change", (e) => {
  const flag = e.target.dataset.flag;
  if (flag) {
    const v = e.target.value;
    if (v === "") delete state.filters.flags[flag];
    else state.filters.flags[flag] = v === "true";
    return filtersChanged();
  }
  const list = e.target.closest("details")?.dataset.list;
  if (list && e.target.type === "checkbox") {
    const cur = new Set(state.filters.lists[list] ?? []);
    if (e.target.checked) cur.add(e.target.value);
    else cur.delete(e.target.value);
    if (cur.size) state.filters.lists[list] = [...cur];
    else delete state.filters.lists[list];
    const box = e.target.closest("details");
    $("summary .muted", box).textContent = cur.size ? `(${cur.size} selected)` : `(${$$(".opts label", box).length})`;
    $("#fp-clear").disabled = activeFilterCount() === 0;
    filtersChanged();
  }
});
$("#filter-panel").addEventListener("input", (e) => {
  if (!e.target.matches(".fp-search")) return;
  const q = e.target.value.trim().toLowerCase();
  $$(".opts label", e.target.closest("details")).forEach((l) => (l.hidden = !!q && !l.dataset.v.includes(q)));
});
$("#filter-panel").addEventListener("click", (e) => {
  if (e.target.id === "fp-close") toggleFilterPanel(false);
  if (e.target.id === "fp-clear") {
    state.filters = { flags: {}, lists: {} };
    filtersChanged();
    toggleFilterPanel(true);
  }
});
$("#filter-btn").addEventListener("click", () => toggleFilterPanel());

// ------------------------------------------------------------------ collections

/** Small text-input dialog (Electron has no window.prompt). Resolves to { text, checked } or null. */
function askText({ title, message = "", placeholder = "", okLabel = "OK", checkbox = "" }) {
  return new Promise((resolve) => {
    const box = $("#chooser");
    box.innerHTML = `<div class="box" role="dialog" aria-modal="true">
      <h2>${esc(title)}</h2>${message ? `<div class="msg">${esc(message)}</div>` : ""}
      <div style="padding:4px 20px 0"><input id="ask-text" style="width:100%" placeholder="${esc(placeholder)}">
      ${checkbox ? `<label style="display:block;margin-top:10px"><input type="checkbox" id="ask-check"> ${esc(checkbox)}</label>` : ""}</div>
      <div class="foot"><button data-x>Cancel</button><button class="primary" data-ok>${esc(okLabel)}</button></div></div>`;
    box.hidden = false;
    $("#ask-text").focus();
    const finish = (value) => {
      box.hidden = true;
      box.innerHTML = "";
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const ok = () => {
      const text = $("#ask-text").value.trim();
      if (text) finish({ text, checked: !!$("#ask-check")?.checked });
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); finish(null); }
      if (e.key === "Enter") { e.preventDefault(); ok(); }
    };
    document.addEventListener("keydown", onKey, true);
    box.onclick = (e) => {
      if (e.target.matches("[data-ok]")) ok();
      else if (e.target.matches("[data-x]") || e.target === box) finish(null);
    };
  });
}

/** Add a game to one of your collections (or a new one). Resolves true when something changed. */
async function addToCollectionFlow(romId, romName, alreadyIn = []) {
  let cols;
  try {
    cols = (await api("collections:list")).filter((c) => c.mine && !alreadyIn.includes(c.id));
  } catch (error) {
    toast(error.message, "error");
    return false;
  }
  const items = cols.map((c) => ({ value: c.id, label: c.name, sub: `${c.romCount} games${c.isPublic ? " · public" : ""}${c.isFavorite ? " · favourites" : ""}` }));
  items.push({ value: "__new", label: "+ New collection…" });
  if (state.view.kind === "collection" && !state.view.smart && state.collections.some((c) => !c.smart && c.id === state.view.id && c.mine !== false)) {
    items.push({ value: "__remove", label: `− Remove from “${state.view.title}”` });
  }
  const pick = await choose({ title: "Add to collection", message: romName, items, selected: items[0].value, okLabel: "OK" });
  if (pick === null) return false;
  try {
    if (pick === "__remove") {
      await api("collections:removeRoms", state.view.id, [romId]);
      toast(`Removed from “${state.view.title}”`, "ok");
      $(`.card[data-id="${romId}"]`)?.remove();
      loadSidebar();
      return true;
    }
    let id = pick;
    let name = cols.find((c) => c.id === pick)?.name;
    if (pick === "__new") {
      const answer = await askText({ title: "New collection", message: `“${romName}” will be added to it.`, placeholder: "Collection name", okLabel: "Create", checkbox: "Public (other RomM users can see it)" });
      if (!answer) return false;
      const created = await api("collections:create", answer.text, answer.checked);
      id = created.id;
      name = created.name;
    }
    await api("collections:addRoms", id, [romId]);
    toast(`Added to “${name}”`, "ok");
    loadSidebar();
    return true;
  } catch (error) {
    toast(error.message, "error");
    return false;
  }
}

// Right-click a card: add it to a collection.
$("#grid").addEventListener("contextmenu", (e) => {
  const card = e.target.closest(".card");
  if (!card || card.dataset.coll || card.dataset.newColl) return;
  e.preventDefault();
  const id = Number(card.dataset.id);
  addToCollectionFlow(id, $(".title", card)?.textContent ?? "");
});

// ------------------------------------------------------------------ collections page

async function renderCollectionsPage() {
  const gen = state.gen;
  showLoading();
  let cols;
  try {
    cols = await api("collections:list");
  } catch (error) {
    if (gen === state.gen) showEmpty(error.message, true, true);
    return;
  }
  if (gen !== state.gen) return;
  state.collections = cols;
  $("#empty").hidden = true;
  const q = state.search.trim().toLowerCase();
  const list = cols.filter((c) => !q || c.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  $("#view-count").textContent = `${cols.length} collection${cols.length === 1 ? "" : "s"}`;
  const card = (c) => {
    const src = img(c.cover);
    const kind = [c.isFavorite ? "Favourites" : "", c.smart ? "Smart" : "", c.isPublic ? "Public" : "Private", c.mine || c.smart ? "" : `by ${c.owner}`].filter(Boolean).join(" · ");
    return `<div class="card" data-coll="${esc(c.key)}" title="${esc(c.description || c.name)}">
      <div class="cover">${src ? `<img loading="lazy" src="${esc(src)}" alt="">` : ""}<span>${src ? "" : esc(c.name)}</span></div>
      <span class="vbadge">${c.romCount} game${c.romCount === 1 ? "" : "s"}</span>
      ${c.mine && !c.isFavorite ? `<button class="coll-del" data-del-coll="${c.id}" title="Delete this collection">✕</button>` : ""}
      <div class="title">${esc(c.name)}</div>
      <div class="sub">${esc(kind)}</div>
    </div>`;
  };
  $("#grid").innerHTML = (q ? "" : `<div class="card" data-new-coll="1">
      <div class="cover new-coll"><span>+ New collection</span></div>
      <div class="title">New collection</div><div class="sub">Add games by right-clicking them</div></div>`) + list.map(card).join("");
  if (!list.length && q) showEmpty("No collection matches your search.");
}

async function collectionsPageClick(e) {
  const del = e.target.closest("[data-del-coll]");
  if (del) {
    e.stopPropagation();
    const c = state.collections.find((x) => !x.smart && x.id === Number(del.dataset.delColl));
    if (!c || !confirm(`Delete the collection “${c.name}”?\n\nOnly the collection is deleted; its ${c.romCount} games stay in your library.`)) return;
    try {
      await api("collections:delete", c.id);
      toast(`Deleted “${c.name}”`, "ok");
    } catch (error) {
      toast(error.message, "error");
    }
    return renderCollectionsPage();
  }
  if (e.target.closest("[data-new-coll]")) {
    const answer = await askText({ title: "New collection", placeholder: "Collection name", okLabel: "Create", checkbox: "Public (other RomM users can see it)" });
    if (!answer) return;
    try {
      const created = await api("collections:create", answer.text, answer.checked);
      toast(`Created “${created.name}”. Right-click games to add them.`, "ok");
    } catch (error) {
      toast(error.message, "error");
    }
    return renderCollectionsPage();
  }
  const card = e.target.closest("[data-coll]");
  if (card) {
    const c = state.collections.find((x) => x.key === card.dataset.coll);
    if (c) setView({ kind: "collection", id: c.id, smart: c.smart, title: c.name });
  }
}

// ------------------------------------------------------------------ chooser

/**
 * Modal list chooser. items: [{ value, label, sub?, tag? }]. Resolves to the picked
 * value, or null when cancelled. Double-click or Enter confirms; Esc cancels.
 */
function choose({ title, message = "", items, selected, okLabel = "OK" }) {
  return new Promise((resolve) => {
    const box = $("#chooser");
    let current = items.some((i) => i.value === selected) ? selected : items[0]?.value;
    box.innerHTML = `<div class="box" role="dialog" aria-modal="true">
      <h2>${esc(title)}</h2>${message ? `<div class="msg">${esc(message)}</div>` : ""}
      <div class="list">${items.map((i, n) => `<div class="opt" data-n="${n}">
        <div style="flex:1;min-width:0"><div class="lbl">${esc(i.label)}</div>${i.sub ? `<div class="sub">${esc(i.sub)}</div>` : ""}</div>
        ${i.tag ? `<span class="tag">${esc(i.tag)}</span>` : ""}</div>`).join("")}</div>
      <div class="foot"><button data-x>Cancel</button><button class="primary" data-ok>${esc(okLabel)}</button></div></div>`;
    box.hidden = false;
    const mark = () => $$(".opt", box).forEach((el) => el.classList.toggle("sel", items[+el.dataset.n].value === current));
    mark();
    $(".opt.sel", box)?.scrollIntoView({ block: "nearest" });
    const finish = (value) => {
      box.hidden = true;
      box.innerHTML = "";
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); finish(null); }
      if (e.key === "Enter") { e.preventDefault(); finish(current); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = items.findIndex((i) => i.value === current) + (e.key === "ArrowDown" ? 1 : -1);
        if (items[n]) { current = items[n].value; mark(); $(".opt.sel", box)?.scrollIntoView({ block: "nearest" }); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    box.onclick = (e) => {
      const opt = e.target.closest(".opt");
      if (opt) { current = items[+opt.dataset.n].value; mark(); if (e.detail === 2) finish(current); return; }
      if (e.target.matches("[data-ok]")) finish(current);
      else if (e.target.matches("[data-x]") || e.target === box) finish(null);
    };
  });
}

/**
 * Ask which copy of each conflicting save to keep: this PC's or WebDAV's (the newer
 * preselected). Resolves to { key: "local" | "remote" }, or null to decide later.
 */
function chooseConflicts(emulator, conflicts) {
  return new Promise((resolve) => {
    const box = $("#chooser");
    const when = (t) => (t ? new Date(t).toLocaleString() : "?");
    const picks = Object.fromEntries(conflicts.map((c) => [c.key, c.remote.mtime > c.local.mtime ? "remote" : "local"]));
    box.innerHTML = `<div class="box" role="dialog" aria-modal="true" style="max-width:760px">
      <h2>Save conflict — ${esc(emulator)}</h2>
      <div class="msg">These files changed both on this PC and on WebDAV since the last sync. Pick the copy to keep;
        the other one is saved in <code>save-backups</code>, so nothing is lost.</div>
      <div class="list">${conflicts.map((c, n) => `<div class="conflict" data-n="${n}">
        <div class="lbl" title="${esc(c.folder + "/" + c.rel)}">${esc(c.rel)} <span class="muted">${esc(c.folder)}</span></div>
        <label><input type="radio" name="c${n}" value="local" ${picks[c.key] === "local" ? "checked" : ""}> This PC · ${esc(when(c.local.mtime))} · ${fmtBytes(c.local.size)}</label>
        <label><input type="radio" name="c${n}" value="remote" ${picks[c.key] === "remote" ? "checked" : ""}> WebDAV · ${esc(when(c.remote.mtime))} · ${fmtBytes(c.remote.size)}</label>
      </div>`).join("")}</div>
      <div class="foot"><button data-x title="Leave both as they are; asked again at the next sync">Decide later</button><button class="primary" data-ok>Keep selected</button></div></div>`;
    box.hidden = false;
    const finish = (value) => {
      box.hidden = true;
      box.innerHTML = "";
      resolve(value);
    };
    box.onchange = (e) => {
      const row = e.target.closest(".conflict");
      if (row) picks[conflicts[+row.dataset.n].key] = e.target.value;
    };
    box.onclick = (e) => {
      if (e.target.matches("[data-ok]")) finish(picks);
      else if (e.target.matches("[data-x]")) finish(null);
    };
  });
}

/** Ask which version of a game to use; preselects a downloaded one. */
function chooseVersion(item, verb) {
  const installed = item.versions.find((v) => v.installed);
  return choose({
    title: `${verb}: ${item.name}`,
    message: `RomM has ${item.versions.length} versions of this game. Which one?`,
    items: item.versions.map((v) => ({ value: v.id, label: v.fileName || v.name, sub: v.fileName && v.name !== v.fileName ? v.name : "", tag: v.installed ? "Downloaded" : "" })),
    selected: installed?.id ?? item.id,
    okLabel: verb,
  });
}

// ------------------------------------------------------------------ play / events

/** The version of a game played last, if it is still one of `versions`. */
function lastVersionOf(versions) {
  const ids = versions.map((v) => v.id);
  const last = ids.map((id) => state.lastVersions?.[id]).find((id) => id !== undefined);
  return ids.includes(last) ? last : null;
}

/** Play one version of a game and remember it, so the next Play starts it directly. */
async function playVersion(versions, id) {
  try {
    state.lastVersions = await api("versions:remember", versions.map((v) => v.id), id);
  } catch {
    // Only a convenience: the game still starts.
  }
  return playGame(id);
}

async function playGame(id) {
  try {
    state.jobs.set(id, { type: "progress", label: "Preparing…", received: 0, total: 0 });
    refreshJob(id);
    await api("game:play", id);
  } catch (error) {
    state.jobs.delete(id);
    refreshJob(id);
    if (error.code === "cancelled") return;
    if (error.code === "no-emulator") {
      toast(error.message + " Pick one in Settings → Platforms.", "error");
      openSettings("platforms", await platformSlugOf(id));
    } else {
      toast(error.message, "error");
    }
  }
}

async function platformSlugOf(id) {
  try { return (await api("rom:get", id)).platformSlug; } catch { return null; }
}

window.romm.onLaunchEvent((ev) => {
  const id = ev.romId;
  switch (ev.type) {
    case "progress": state.jobs.set(id, ev); break;
    case "running": state.jobs.set(id, ev); toast(`Started in ${ev.emulator}`, "ok"); break;
    case "installed": state.jobs.delete(id); markInstalled(id); break;
    case "exited":
      state.jobs.delete(id);
      if (ev.code && ev.seconds < 5) toast(`Emulator exited immediately (code ${ev.code}). Check the emulator path and arguments.`, "error");
      break;
    case "idle": state.jobs.delete(id); break;
    case "choose-file":
      choose({
        title: "Which file should be launched?",
        message: "This game has several files. The choice is remembered; change it later in the game's details.",
        items: ev.files.map((f) => ({ value: f, label: f })),
        selected: ev.suggested,
        okLabel: "Launch",
      }).then((rel) => api("game:chooseFile", id, rel));
      break;
    case "save-conflicts":
      chooseConflicts(ev.emulator, ev.conflicts).then((answers) => api("saves:resolveConflicts", ev.requestId, answers));
      return;
    case "notice":
      toast(ev.message, ev.level);
      if (state.detailId === id) api("rom:get", id).then((rom) => { if (state.detailId === id) { detailRom = rom; renderDetail(); } }).catch(() => {});
      return;
  }
  refreshJob(id);
});

function markInstalled(id) {
  const card = $(`.card[data-id="${id}"]`);
  if (card && !$(".badge", card)) card.insertAdjacentHTML("afterbegin", '<span class="badge" title="Downloaded">✓</span>');
}

/** The card showing game `id`, which may be one of the versions folded into it. */
function cardOf(id) {
  const own = $(`.card[data-id="${id}"]`);
  if (own) return own;
  for (const [cardId, item] of state.items ?? []) {
    if (item.versions?.some((v) => v.id === id)) return $(`.card[data-id="${cardId}"]`);
  }
  return null;
}

function refreshJob(id) {
  const card = cardOf(id);
  const job = state.jobs.get(id);
  if (card) {
    $(".bar", card)?.remove();
    if (job && job.type === "progress") {
      const pct = job.total ? Math.round((job.received / job.total) * 100) : 0;
      $(".cover", card).insertAdjacentHTML("afterend", `<div class="bar"><i style="width:${pct}%"></i></div>`);
    }
  }
  if (state.detailId === id) renderDetailActions();
}

// ------------------------------------------------------------------ detail

let detailRom = null;

async function openDetail(id) {
  state.detailId = id;
  const drawer = $("#detail");
  drawer.hidden = false;
  drawer.innerHTML = '<button class="close">✕</button><div class="pad muted" style="padding:30px">Loading…</div>';
  try {
    const rom = await api("rom:get", id);
    if (state.detailId !== id) return;
    detailRom = rom;
    renderDetail();
  } catch (error) {
    drawer.innerHTML = `<button class="close">✕</button><div class="pad">${esc(error.message)}</div>`;
  }
}

function closeDetail() {
  state.detailId = null;
  $("#detail").hidden = true;
}

function renderDetail() {
  const r = detailRom;
  const cover = img(r.cover, r.coverUrl);
  const chips = [...r.genres, ...r.regions, ...r.languages].filter(Boolean);
  const installed = r.installed;
  $("#detail").innerHTML = `
    <button class="close" title="Close (Esc)">✕</button>
    <div class="detail-head">
      <div class="cover">${cover ? `<img src="${esc(cover)}" alt="">` : ""}</div>
      <div>
        <h2>${esc(r.name)}</h2>
        <div class="meta">${esc(r.platformName)}${r.year ? " · " + r.year : ""} · ${fmtBytes(r.sizeBytes)}</div>
        ${r.companies?.length ? `<div class="meta">${esc(r.companies.slice(0, 3).join(", "))}</div>` : ""}
        <div class="meta">Emulator: ${r.emulator ? esc(r.emulator) : `<a data-act="map">not set — choose one</a>`}</div>
        <div class="chips">${chips.slice(0, 10).map((c) => `<span class="chip">${esc(c)}</span>`).join("")}</div>
      </div>
    </div>
    <div class="actions" id="detail-actions"></div>
    <div class="progress" id="detail-progress" hidden></div>
    <div class="detail-body">
      ${r.versions?.length > 1 ? `<h3 style="margin-top:4px">Versions (${r.versions.length})</h3>
        <div class="versions">${r.versions.map((v) => `<div class="opt ${v.id === r.id ? "cur" : ""}" data-version="${v.id}" title="${esc(v.name)}">
          <span class="lbl">${esc(v.fileName || v.name)}</span>${v.id === lastVersionOf(r.versions) ? '<span class="chip">▶ last played</span>' : ""}${v.installed ? '<span class="chip">✓ downloaded</span>' : ""}</div>`).join("")}</div>
        <div class="hint">Play / Download apply to the highlighted version. Playing it here also makes it the version ▶ on the card starts.</div>` : ""}
      ${r.offline ? '<div class="hint">Offline: details as RomM last gave them.</div>' : `<h3>Collections</h3>
      <div class="chips">${(r.collections ?? []).map((c) => `<span class="chip col-chip">${esc(c.name)}<button data-remove-col="${c.id}" title="Remove from this collection">✕</button></span>`).join("")}
        <button class="chip" data-act="addcol">+ Add to collection</button></div>`}
      ${r.summary ? `<h3>Summary</h3><div class="summary">${esc(r.summary)}</div>` : ""}
      ${installed ? `<h3>Downloaded files</h3><div class="files">${installed.files.map((f) => `
        <div><label><input type="radio" name="launch" value="${esc(f)}" ${f === installed.launchFile ? "checked" : ""}> ${esc(f)}</label></div>`).join("")}
        <div class="hint" style="border:0">The selected file is passed to the emulator as {rom}. Location: ${esc(installed.dir)}</div></div>`
      : r.files.length ? `<h3>Files on server</h3><div class="files">${r.files.map((f) => `<div><span>${esc(f.name)}</span><span>${fmtBytes(f.size)}</span></div>`).join("")}</div>` : ""}
      ${savesHtml(r)}
      ${r.screenshots?.length ? `<h3>Screenshots</h3><div class="shots">${r.screenshots.map((s) => img(s.s, s.u)).filter(Boolean).map((src) => `<img loading="lazy" src="${esc(src)}">`).join("")}</div>` : ""}
    </div>`;
  renderDetailActions();
}

/** Why this game's saves cannot be synced right now, or null when they can. */
const webdavSaves = () => state.config?.syncSaves && state.config?.saveBackend === "webdav";

function syncBlocker(r) {
  const job = state.jobs.get(r.id);
  if (!r.installed) return "Download the game first: saves are matched to its files.";
  if (webdavSaves()) {
    if (!r.emulator) return "No emulator is set for this platform.";
    if (job && (job.type === "running" || job.type === "progress")) return "Wait for the game to close; its saves sync then.";
    return null;
  }
  if (r.offline) return "RomM cannot be reached.";
  if (!r.syncSaves) return "Save sync is turned off (Settings → Storage).";
  if (!r.emulator) return "No emulator is set for this platform.";
  if (r.saveMode === "off") return "Save sync is off for this emulator: choose where it keeps saves in Settings → Emulators.";
  if (job && (job.type === "running" || job.type === "progress")) return "Wait for the game to close; its saves sync then.";
  return null;
}

function savesHtml(r) {
  if (webdavSaves()) {
    const blocker = syncBlocker(r);
    return `<h3>Saves on WebDAV</h3>
      <div class="row" style="margin-bottom:6px"><span class="hint" style="flex:1">${esc(blocker && r.installed ? blocker
        : `The save folders of ${r.emulator ?? "its emulator"} sync with WebDAV before each launch and after it closes (Settings → Emulators chooses them).`)}</span>
        ${r.installed && !blocker ? '<button data-act="sync" title="Sync this emulator\'s save folders with WebDAV now">⟳ Sync now</button>' : ""}</div>`;
  }
  const rows = [...r.saves.map((s) => ({ ...s, kind: "Save" })), ...r.states.map((s) => ({ ...s, kind: "State" }))]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const blocker = syncBlocker(r);
  const status = r.offline ? "Offline: saves are kept on this PC and upload when RomM is reachable again."
    : blocker && r.installed ? blocker
    : !r.syncSaves ? "Save sync is turned off (Settings → Storage)."
    : r.saveMode === "off" ? "Save sync is off for this emulator (Settings → Emulators)."
    : "Pulled before each launch, uploaded when the emulator closes.";
  if (r.offline) return `<h3>Saves</h3><div class="hint">${esc(status)}</div>`;
  return `<h3>Saves on RomM</h3>
    <div class="row" style="margin-bottom:6px"><span class="hint" style="flex:1">${esc(status)}</span>
      ${r.installed && !blocker ? '<button data-act="sync" title="Download newer saves from RomM, then upload the ones changed here">⟳ Sync now</button>' : ""}</div>
    ${rows.length ? `<div class="files">${rows.map((s) => `<div><span>${s.kind}: ${esc(s.name)}${s.emulator ? ` <span class="muted">(${esc(s.emulator)})</span>` : ""}</span>
      <span>${s.updatedAt ? esc(new Date(s.updatedAt).toLocaleString()) : ""} · ${fmtBytes(s.size)}</span></div>`).join("")}</div>`
    : '<div class="muted">None yet.</div>'}`;
}

function renderDetailActions() {
  const r = detailRom;
  if (!r || state.detailId !== r.id) return;
  const job = state.jobs.get(r.id);
  const box = $("#detail-actions");
  const prog = $("#detail-progress");
  if (!box) return;
  const busy = job && job.type === "progress";
  const running = job && job.type === "running";
  box.innerHTML = `
    ${running ? `<button class="primary" disabled>Running…</button><button data-act="stop">Stop</button>`
      : busy ? `<button class="primary" disabled>Working…</button><button data-act="cancel">Cancel</button>`
      : `<button class="primary" data-act="play">▶ Play</button>`}
    ${!r.installed && !busy && !running ? '<button data-act="install">⭳ Download only</button>' : ""}
    ${r.offline ? "" : (r.collections ?? []).some((c) => c.isFavorite) ? '<button data-act="unfav" title="Remove from your RomM favourites">★ Favourite</button>' : '<button data-act="fav" title="Add to your RomM favourites">☆ Favourite</button>'}
    ${r.installed ? `<button data-act="sync" ${syncBlocker(r) ? `disabled title="${esc(syncBlocker(r))}"` : 'title="Download newer saves from RomM, then upload the ones changed here"'}>⟳ Sync saves</button>` : ""}
    ${r.installed && !busy && !running ? '<button data-act="folder">Open folder</button><button class="danger" data-act="uninstall">Delete local copy</button>' : ""}
    ${r.offline ? "" : '<button data-act="web">Open in RomM</button>'}`;
  if (busy) {
    prog.hidden = false;
    const pct = job.total ? (job.received / job.total) * 100 : 0;
    prog.innerHTML = `<div class="meta" style="margin-bottom:5px">${esc(job.label)} — ${fmtBytes(job.received)}${job.total ? " / " + fmtBytes(job.total) : ""}</div>
      <div class="track ${job.total ? "" : "indet"}"><i style="width:${pct}%"></i></div>`;
  } else {
    prog.hidden = true;
  }
}

$("#detail").addEventListener("click", async (e) => {
  if (e.target.closest(".close")) return closeDetail();
  const removeCol = e.target.closest("[data-remove-col]");
  if (removeCol && detailRom) {
    const colId = Number(removeCol.dataset.removeCol);
    try {
      await api("collections:removeRoms", colId, [detailRom.id]);
      toast("Removed from the collection", "ok");
      loadSidebar();
      if (state.view.kind === "collection" && state.view.id === colId) $(`.card[data-id="${detailRom.id}"]`)?.remove();
      detailRom = await api("rom:get", detailRom.id);
      renderDetail();
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }
  const version = e.target.closest("[data-version]");
  if (version) return openDetail(Number(version.dataset.version));
  const act = e.target.closest("[data-act]")?.dataset.act;
  const r = detailRom;
  if (!act || !r) return;
  try {
    if (act === "play") await (r.versions?.length > 1 ? playVersion(r.versions, r.id) : playGame(r.id));
    if (act === "install") {
      state.jobs.set(r.id, { type: "progress", label: "Preparing…", received: 0, total: 0 });
      renderDetailActions();
      await api("game:install", r.id);
      toast(`${r.name} downloaded`, "ok");
    }
    if (act === "cancel" || act === "stop") await api("game:cancel", r.id);
    if (act === "folder") await api("game:openFolder", r.id);
    if (act === "fav" || act === "unfav") {
      const on = await api("collections:setFavorite", r.id, act === "fav");
      toast(on ? "Added to favourites" : "Removed from favourites", "ok");
      detailRom = await api("rom:get", r.id);
      renderDetail();
      // In "Favourites first" the game's place in the list changes.
      if (state.sort === "favorite:first" || state.filters.flags.favorite !== undefined) reload();
    }
    if (act === "addcol" && (await addToCollectionFlow(r.id, r.name, (r.collections ?? []).map((c) => c.id))) && state.detailId === r.id) {
      detailRom = await api("rom:get", r.id);
      renderDetail();
    }
    if (act === "sync") {
      $$('[data-act="sync"]').forEach((b) => { b.disabled = true; b.textContent = "Syncing…"; });
      try {
        toast(`${r.name}: ${await api("game:syncSaves", r.id)}`, "ok");
      } finally {
        // Refresh the saves RomM now holds.
        if (state.detailId === r.id) {
          detailRom = await api("rom:get", r.id).catch(() => detailRom);
          renderDetail();
        }
      }
    }
    if (act === "web") await api("open:external", r.webUrl);
    if (act === "map") return openSettings("platforms", r.platformSlug);
    if (act === "uninstall") {
      if (!confirm(`Delete the downloaded files of "${r.name}"? The game stays on your RomM server.`)) return;
      await api("game:uninstall", r.id);
      $(`.card[data-id="${r.id}"] .badge`)?.remove();
      if (state.view.kind === "installed") reload();
    }
  } catch (error) {
    state.jobs.delete(r.id);
    toast(error.message, "error");
  }
  if (["install", "uninstall", "play", "sync"].includes(act) && state.detailId === r.id) {
    detailRom = await api("rom:get", r.id).catch(() => detailRom);
    renderDetail();
  }
});

$("#detail").addEventListener("change", async (e) => {
  if (e.target.name !== "launch" || !detailRom) return;
  await api("game:setLaunchFile", detailRom.id, e.target.value);
  toast("Launch file updated", "ok");
});

// ------------------------------------------------------------------ settings

let settingsTab = "server";
let presets = null;

async function openSettings(tab, focusSlug) {
  closeDetail();
  if (tab) settingsTab = tab;
  state.view = { kind: "settings" };
  markActive();
  $("#content").hidden = true;
  $("#toolbar").hidden = true;
  $("#filter-panel").hidden = true;
  $("#settings").hidden = false;
  $("#about").hidden = true;
  presets ??= await api("emulators:presets");
  state.config = await api("config:get");
  renderSettings(focusSlug);
}

function renderSettings(focusSlug) {
  const tabs = [["server", "Server"], ["emulators", "Emulators"], ["platforms", "Platforms"], ["storage", "Storage"], ["appearance", "Appearance"], ["tools", "Tools"]];
  $("#settings").innerHTML = `
    <h1 style="margin-top:0">Settings</h1>
    <div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === settingsTab ? "active" : ""}">${l}</button>`).join("")}</div>
    <div id="tab-body"></div>`;
  ({ server: renderServer, emulators: renderEmulators, platforms: renderPlatforms, storage: renderStorage, appearance: renderAppearance, tools: renderTools })[settingsTab](focusSlug);
}

$("#settings").addEventListener("click", (e) => {
  const tab = e.target.closest("[data-tab]");
  if (tab) { settingsTab = tab.dataset.tab; renderSettings(); }
});

async function save(patch, quiet) {
  state.config = await api("config:set", patch);
  if (!quiet) toast("Saved", "ok");
}

function renderServer() {
  const c = state.config;
  $("#tab-body").innerHTML = `
    <div class="form">
      <label>Server URL</label><input id="s-url" value="${esc(c.serverUrl)}" placeholder="https://romm.example.com">
      <label>Authentication</label>
      <select id="s-auth">
        <option value="basic" ${c.authType === "basic" ? "selected" : ""}>Username &amp; password</option>
        <option value="token" ${c.authType === "token" ? "selected" : ""}>API / client token</option>
      </select>
      <label class="basic">Username</label><input class="basic" id="s-user" value="${esc(c.username)}" autocomplete="off">
      <label class="basic">Password</label><input class="basic" id="s-pass" type="password" placeholder="${c.hasPassword ? "(saved — leave empty to keep)" : ""}" autocomplete="new-password">
      <label class="token">Token</label><input class="token" id="s-token" type="password" value="${esc(c.token)}" autocomplete="off">
      <label></label><label><input type="checkbox" id="s-tls" ${c.allowSelfSigned ? "checked" : ""}> Accept self-signed HTTPS certificates</label>
      <label></label><div class="row"><button class="primary" id="s-save">Save &amp; test connection</button><span id="s-result" class="muted"></span></div>
      <div class="full hint">The password is encrypted with Windows' data protection and stored only on this PC.
      A token can be created in RomM under your profile (client API tokens) and needs at least read access to roms, platforms and collections.</div>
    </div>`;
  const sync = () => {
    const token = $("#s-auth").value === "token";
    $$(".basic").forEach((el) => (el.hidden = token));
    $$(".token").forEach((el) => (el.hidden = !token));
  };
  sync();
  $("#s-auth").addEventListener("change", sync);
  $("#s-save").addEventListener("click", async () => {
    const patch = {
      serverUrl: $("#s-url").value,
      authType: $("#s-auth").value,
      username: $("#s-user").value,
      token: $("#s-token").value.trim(),
      allowSelfSigned: $("#s-tls").checked,
    };
    if ($("#s-pass").value) patch.password = $("#s-pass").value;
    await save(patch, true);
    $("#s-result").textContent = "Testing…";
    try {
      const me = await api("server:test");
      user.name = me.username;
      renderUser();
      $("#s-result").innerHTML = `<span style="color:var(--ok)">✓ Connected as ${esc(me.username)}${me.version ? ` · RomM ${esc(me.version)}` : ""}</span>`;
      loadSidebar();
    } catch (error) {
      $("#s-result").innerHTML = `<span style="color:var(--danger)">✕ ${esc(error.message)}</span>`;
    }
  });
}

function newId() { return Math.random().toString(36).slice(2, 10); }

/** Same inference as the main process, for emulators saved before save sync existed. */
const modeOf = (e) => e.saveMode || (/retroarch/i.test(e.path || "") ? "retroarch" : "off");

// ---- emulators the launcher downloads and updates

const emuCatalog = { updates: {}, busy: new Map() };

window.romm.onEmuProgress((ev) => {
  const text = ev.total ? `${ev.label} — ${fmtBytes(ev.received)} / ${fmtBytes(ev.total)}`
    : ev.received ? `${ev.label} — ${fmtBytes(ev.received)}` : ev.label;
  emuCatalog.busy.set(ev.key, text);
  $$(`[data-emu-status="${ev.key}"]`).forEach((el) => { el.hidden = false; el.textContent = text; });
});

/** Platforms in the library, which new emulators are mapped to. */
const librarySlugs = () => state.platforms.flatMap((p) => [p.slug, p.fsSlug]).filter(Boolean);

/** Download (or update) a catalog emulator. Resolves to the emulator entry, or null. */
async function installFromCatalog(key) {
  const preset = presets.presets.find((p) => p.key === key);
  emuCatalog.busy.set(key, `Downloading ${preset.name}…`);
  refreshEmuViews();
  try {
    const emulator = await api("emulators:install", key, librarySlugs());
    delete emuCatalog.updates[key];
    toast(`${preset.name} ${emulator.managed.version} installed`, "ok");
    return emulator;
  } catch (error) {
    toast(`${preset.name}: ${error.message}`, "error");
    return null;
  } finally {
    emuCatalog.busy.delete(key);
    state.config = await api("config:get");
    refreshEmuViews();
  }
}

/** Ask RomM-independent sources for newer releases of the emulators the launcher installed. */
async function checkEmulatorUpdates() {
  emuCatalog.updates = await api("emulators:checkUpdates");
  return Object.entries(emuCatalog.updates).filter(([, u]) => u.version).map(([key]) => key);
}

/** The cores of the platforms RetroArch runs here, or that it would run in this library. */
function wantedCores(retroarch) {
  const mapped = Object.entries(state.config.platforms).filter(([, m]) => m.emulatorId === retroarch.id).map(([slug, m]) => m.core || presets.defaultCores[slug]);
  const preset = presets.presets.find((p) => p.key === "retroarch");
  const wanted = mapped.length ? mapped : preset.platforms.filter((s) => librarySlugs().includes(s)).map((s) => presets.defaultCores[s]);
  return [...new Set(wanted.filter(Boolean))];
}

async function downloadCores(retroarch) {
  const cores = wantedCores(retroarch);
  if (!cores.length) return toast("No platform uses RetroArch yet: assign some in Settings → Platforms.", "error");
  emuCatalog.busy.set("retroarch", "Downloading cores…");
  refreshEmuViews();
  try {
    const done = await api("emulators:installCores", cores);
    toast(`Downloaded ${done.length} of ${cores.length} cores: ${done.join(", ")}`, done.length === cores.length ? "ok" : "error");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    emuCatalog.busy.delete("retroarch");
    refreshEmuViews();
  }
}

/** Redraw whichever page shows emulator state. */
function refreshEmuViews() {
  if (state.view.kind === "settings" && settingsTab === "emulators") renderEmulators();
  if (state.view.kind === "about") renderAbout();
}

/** The line under a launcher-installed emulator: version, update, folder. */
function managedLine(e) {
  if (!e.managed) return "";
  const key = e.managed.key;
  const busy = emuCatalog.busy.get(key);
  const update = emuCatalog.updates[key];
  return `<label>Installed by the launcher</label><div class="row">
    <span>${esc(e.managed.version)}${update?.version ? ` · <b>${esc(update.version)} available</b>` : ""}</span>
    <span class="muted" data-emu-status="${key}" ${busy ? "" : "hidden"}>${esc(busy ?? "")}</span>
    <div class="spacer"></div>
    ${busy ? "" : `${update?.version ? `<button class="primary" data-emu-update="${key}">Update</button>` : ""}
      ${key === "retroarch" ? "<button data-emu-cores>Download cores</button>" : ""}
      <button data-emu-folder="${key}">Open folder</button>`}</div>`;
}

/** An emulator card's WebDAV save folders: one checkbox each, and Add folder. */
function syncFoldersHtml(e, folders) {
  const list = folders?.[e.id] ?? [];
  return `<label>Synced save folders</label><div class="sync-folders">
    ${list.length ? list.map((f, i) => `<label title="${esc(f.local)}"><input type="checkbox" data-sf="${i}" ${f.enabled ? "checked" : ""}>
      <b>${esc(f.name)}</b> <span class="muted">${esc(f.local)}${f.exists ? "" : " — not there yet"}</span></label>`).join("")
      : '<div class="muted">None known for this emulator; add the folder where it keeps saves.</div>'}
    <button data-sf-add>Add folder…</button></div>`;
}

async function renderEmulators() {
  const c = state.config;
  const webdav = c.syncSaves && c.saveBackend === "webdav";
  const folders = webdav ? await api("saves:folders").catch(() => ({})) : null;
  const adding = [...emuCatalog.busy.keys()].filter((key) => !c.emulators.some((e) => e.managed?.key === key));
  $("#tab-body").innerHTML = `
    <div class="row" style="margin-bottom:14px">
      <select id="e-preset">${presets.presets.map((p) => `<option value="${p.key}">${esc(p.name)}${p.source ? "" : p.key === "custom" ? "" : " (browse only)"}</option>`).join("")}</select>
      <button class="primary" id="e-add">+ Add emulator</button>
      <button id="e-detect">Detect RetroArch</button>
    </div>
    ${adding.map((key) => `<div class="hint" data-emu-status="${key}" style="margin-bottom:10px">${esc(emuCatalog.busy.get(key))}</div>`).join("")}
    <div class="hint" style="margin-bottom:14px">Argument placeholders: <code>{rom}</code> full path of the game file,
      <code>{romDir}</code>, <code>{romFile}</code>, <code>{romName}</code> (no extension), <code>{emuDir}</code> emulator folder,
      <code>{core}</code> libretro core set per platform. Quote anything that may contain spaces.<br>
      Save sync: <b>RetroArch</b> keeps each game's saves and states in its own synced folder (added with <code>--appendconfig</code>, your retroarch.cfg is untouched).
      <b>Custom</b> patterns accept the same placeholders plus <code>{saveDir}</code>, and <code>*</code> in the file name.</div>
    <div id="e-list">${c.emulators.length ? "" : '<div class="muted">No emulators yet.</div>'}</div>`;
  $("#e-list").insertAdjacentHTML("beforeend", c.emulators.map((e) => `
    <div class="emu" data-id="${e.id}">
      <div class="emu-head"><input data-f="name" value="${esc(e.name)}"><div class="spacer"></div><button class="danger" data-del>Remove</button></div>
      <div class="form">
        ${managedLine(e)}
        <label>Executable</label><div class="row"><input data-f="path" value="${esc(e.path)}"><button data-browse>Browse…</button></div>
        <label>Arguments</label><input data-f="args" value="${esc(e.args)}">
        <label></label><label><input type="checkbox" data-f="extractZip" ${e.extractZip ? "checked" : ""}> Extract .zip games before launching</label>
        ${webdav ? syncFoldersHtml(e, folders) : ""}
        <label ${webdav ? "hidden" : ""}>Save sync</label>
        <select data-f="saveMode" ${webdav ? "hidden" : ""}>
          <option value="off" ${modeOf(e) === "off" ? "selected" : ""}>Off</option>
          <option value="retroarch" ${modeOf(e) === "retroarch" ? "selected" : ""}>RetroArch (automatic)</option>
          <option value="custom" ${modeOf(e) === "custom" ? "selected" : ""}>Custom file patterns</option>
        </select>
        <label class="pat" ${modeOf(e) === "custom" && !webdav ? "" : "hidden"}>Save files</label><input class="pat" data-f="savePattern" value="${esc(e.savePattern ?? "")}" placeholder="{romDir}/{romName}.sav" ${modeOf(e) === "custom" && !webdav ? "" : "hidden"}>
        <label class="pat" ${modeOf(e) === "custom" && !webdav ? "" : "hidden"}>State files</label><input class="pat" data-f="statePattern" value="${esc(e.statePattern ?? "")}" placeholder="{romDir}/{romName}.ss*" ${modeOf(e) === "custom" && !webdav ? "" : "hidden"}>
      </div>
    </div>`).join(""));

  const commit = async () => {
    const emulators = $$(".emu").map((el) => ({
      // Keep what the form does not show, such as the launcher's install record.
      ...state.config.emulators.find((x) => x.id === el.dataset.id),
      id: el.dataset.id,
      name: $('[data-f="name"]', el).value.trim() || "Emulator",
      path: $('[data-f="path"]', el).value.trim(),
      args: $('[data-f="args"]', el).value,
      extractZip: $('[data-f="extractZip"]', el).checked,
      saveMode: $('[data-f="saveMode"]', el).value,
      savePattern: $('[data-f="savePattern"]', el).value.trim(),
      statePattern: $('[data-f="statePattern"]', el).value.trim(),
    }));
    await save({ emulators }, true);
  };
  // A synced-folder list, written whole so the catalog defaults become the emulator's own.
  const saveFolders = async (id, list) => {
    const emulators = state.config.emulators.map((x) => (x.id === id ? { ...x, syncFolders: list.map(({ name, path, enabled }) => ({ name, path, enabled })) } : x));
    await save({ emulators }, true);
    renderEmulators();
  };
  $("#e-list").addEventListener("change", async (e) => {
    if (e.target.dataset.sf !== undefined) {
      const id = e.target.closest(".emu").dataset.id;
      const list = (folders?.[id] ?? []).map((f, i) => (i === Number(e.target.dataset.sf) ? { ...f, enabled: e.target.checked } : f));
      return saveFolders(id, list);
    }
    if (e.target.dataset.f === "saveMode") {
      const box = e.target.closest(".emu");
      $$(".pat", box).forEach((el) => (el.hidden = e.target.value !== "custom"));
    }
    await commit();
  });
  $("#e-list").addEventListener("click", async (e) => {
    const box = e.target.closest(".emu");
    if (e.target.matches("[data-del]")) {
      if (!confirm("Remove this emulator?\n\nIts files stay where they are.")) return;
      box.remove();
      await commit();
      return renderEmulators();
    }
    if (e.target.matches("[data-browse]")) {
      const path = await api("dialog:pickExe");
      if (path) { $('[data-f="path"]', box).value = path; await commit(); }
    }
    const update = e.target.closest("[data-emu-update]")?.dataset.emuUpdate;
    if (update) return installFromCatalog(update);
    const folder = e.target.closest("[data-emu-folder]")?.dataset.emuFolder;
    if (folder) return api("emulators:openFolder", folder);
    if (e.target.closest("[data-emu-cores]")) return downloadCores(state.config.emulators.find((x) => x.id === box.dataset.id));
    if (e.target.closest("[data-sf-add]")) {
      const dir = await api("dialog:pickSaveFolder", box.dataset.id);
      if (!dir) return;
      const name = dir.split(/[\\/]/).filter(Boolean).pop() || "saves";
      return saveFolders(box.dataset.id, [...(folders?.[box.dataset.id] ?? []), { name, path: dir, enabled: true }]);
    }
  });

  const addFromPreset = async (preset, path = "") => {
    const emu = {
      id: newId(), name: preset.name, path, args: preset.args, extractZip: preset.extractZip,
      saveMode: preset.saveMode ?? "off", savePattern: preset.savePattern ?? "", statePattern: preset.statePattern ?? "",
    };
    const platforms = { ...state.config.platforms };
    // Map this emulator to its usual platforms that have no emulator yet.
    for (const slug of preset.platforms) {
      if (!platforms[slug] && state.platforms.some((p) => p.slug === slug || p.fsSlug === slug)) {
        platforms[slug] = { emulatorId: emu.id, core: preset.key === "retroarch" ? presets.defaultCores[slug] : undefined };
      }
    }
    await save({ emulators: [...state.config.emulators, emu], platforms }, true);
    renderEmulators();
    return emu;
  };

  $("#e-add").addEventListener("click", async () => {
    const preset = presets.presets.find((p) => p.key === $("#e-preset").value);
    if (preset.source) {
      if (state.config.emulators.some((e) => e.managed?.key === preset.key)) {
        return toast(`${preset.name} is already installed by the launcher; update it from its card.`, "error");
      }
      const how = await choose({
        title: `Add ${preset.name}`,
        message: "Download it, or use a copy already on this PC?",
        items: [
          { value: "download", label: `Download ${preset.name}`, sub: `Latest release, into ${state.config.emulatorDir || "emulators"}\\${preset.key}. The launcher can update it later.` },
          { value: "browse", label: "Use an existing one", sub: "Pick its executable." },
        ],
        selected: "download",
        okLabel: "Continue",
      });
      if (!how) return;
      if (how === "download") return installFromCatalog(preset.key);
    }
    let path = preset.key === "retroarch" ? (await api("emulators:detectRetroArch")) ?? "" : "";
    if (!path && preset.key !== "custom") path = (await api("dialog:pickExe")) ?? "";
    await addFromPreset(preset, path);
    toast(`${preset.name} added${path ? "" : " — set the executable path"}. Unmapped platforms were assigned to it.`, "ok");
  });
  $("#e-detect").addEventListener("click", async () => {
    const path = await api("emulators:detectRetroArch");
    if (!path) return toast("RetroArch not found in the usual folders. Add it and browse to retroarch.exe.", "error");
    if (state.config.emulators.some((e) => e.path.toLowerCase() === path.toLowerCase())) return toast(`Already configured: ${path}`);
    await addFromPreset(presets.presets.find((p) => p.key === "retroarch"), path);
    toast(`Found RetroArch at ${path}`, "ok");
  });
}

async function renderPlatforms(focusSlug) {
  const c = state.config;
  if (!state.platforms.length) {
    $("#tab-body").innerHTML = '<div class="muted">Connect to the server first (Server tab).</div>';
    return;
  }
  // Installed cores per emulator (RetroArch's cores folder), for the core picker.
  const coresByEmu = {};
  for (const e of c.emulators) coresByEmu[e.id] = e.path ? await api("emulators:cores", e.path).catch(() => []) : [];
  const sep = c.romDir.includes("/") && !c.romDir.includes("\\") ? "/" : "\\";

  const coreOptions = (emuId, slug, current) => {
    const installed = coresByEmu[emuId] ?? [];
    const suggested = presets.defaultCores[slug];
    const names = [...new Set([current, suggested, ...installed].filter(Boolean))].sort();
    if (!emuId) return '<option value="">—</option>';
    return `<option value="">— none —</option>${names.map((n) => `<option value="${esc(n)}" ${n === current ? "selected" : ""}>${esc(n)}${n === suggested ? " ★" : ""}${installed.length && !installed.includes(n) ? " (not installed)" : ""}</option>`).join("")}
      <option value="__other">Other…</option>`;
  };

  $("#tab-body").innerHTML = `
    <div class="row" style="margin-bottom:10px">
      <input id="p-filter" type="search" placeholder="Filter platforms…" style="max-width:320px">
      <label><input type="checkbox" id="p-unmapped"> Only platforms without an emulator</label>
    </div>
    <div class="hint" style="margin-bottom:12px">The core (★ = suggested) is used by the <code>{core}</code> placeholder (RetroArch).
      Arguments override the emulator's default for this platform only. Download folder: where this platform's games are saved,
      as <code>folder${sep}rom.ext</code>; leave empty for <code>${esc(c.romDir)}${sep}&lt;slug&gt;</code>. Point it at an existing ROM
      folder and games already there are used without downloading.</div>
    <table class="platforms">
      <thead><tr><th style="width:20%">Platform</th><th style="width:16%">Emulator</th><th style="width:17%">Core</th><th style="width:17%">Arguments override</th><th>Download folder</th></tr></thead>
      <tbody>${state.platforms.map((p) => {
        const key = c.platforms[p.slug] ? p.slug : c.platforms[p.fsSlug] ? p.fsSlug : p.slug;
        const m = c.platforms[key] || {};
        return `<tr data-slug="${esc(key)}" data-search="${esc((p.name + " " + p.slug + " " + p.fsSlug).toLowerCase())}" class="${focusSlug && (focusSlug === p.slug || focusSlug === p.fsSlug) ? "focus" : ""}">
          <td><b>${esc(p.name)}</b><div class="hint">${esc(p.slug)} · ${p.romCount} games</div></td>
          <td><select data-f="emulatorId"><option value="">— none —</option>${c.emulators.map((e) => `<option value="${e.id}" ${m.emulatorId === e.id ? "selected" : ""}>${esc(e.name)}</option>`).join("")}</select></td>
          <td><select data-f="coreSel" ${m.emulatorId ? "" : "disabled"}>${coreOptions(m.emulatorId, p.slug, m.core)}</select>
              <input data-f="core" value="${esc(m.core ?? "")}" placeholder="core name" hidden></td>
          <td><input data-f="args" value="${esc(m.args ?? "")}" placeholder="default"></td>
          <td><div class="row"><input data-f="folder" value="${esc(m.folder ?? "")}" placeholder="default"><button data-browse title="Choose folder">…</button></div></td>
        </tr>`;
      }).join("")}</tbody>
    </table>`;

  const applyFilter = () => {
    const q = $("#p-filter").value.trim().toLowerCase();
    const unmapped = $("#p-unmapped").checked;
    for (const tr of $$(".platforms tbody tr")) {
      const hasEmu = !!$('[data-f="emulatorId"]', tr).value;
      tr.hidden = (q && !tr.dataset.search.includes(q)) || (unmapped && hasEmu);
    }
  };
  $("#p-filter").addEventListener("input", applyFilter);
  $("#p-unmapped").addEventListener("change", applyFilter);

  const commitRow = async (tr) => {
    const slug = tr.dataset.slug;
    const emulatorId = $('[data-f="emulatorId"]', tr).value;
    const core = $('[data-f="core"]', tr).value.trim();
    const args = $('[data-f="args"]', tr).value.trim();
    const folder = $('[data-f="folder"]', tr).value.trim();
    const platforms = { ...state.config.platforms };
    if (!emulatorId && !folder && !args) delete platforms[slug];
    else platforms[slug] = { emulatorId, core: (emulatorId && core) || undefined, args: args || undefined, folder: folder || undefined };
    await save({ platforms }, true);
    loadSidebar();
  };

  $(".platforms").addEventListener("change", async (e) => {
    const tr = e.target.closest("tr");
    const f = e.target.dataset.f;
    const coreSel = $('[data-f="coreSel"]', tr);
    const coreInput = $('[data-f="core"]', tr);
    if (f === "emulatorId") {
      // New emulator: offer its cores, pre-selecting the suggested one if it has any.
      const emuId = e.target.value;
      const suggested = (coresByEmu[emuId]?.length || saveModeOrRetro(emuId)) ? presets.defaultCores[tr.dataset.slug] ?? "" : "";
      const current = coreInput.value.trim() || suggested;
      coreInput.value = emuId ? current : "";
      coreSel.innerHTML = coreOptions(emuId, tr.dataset.slug, coreInput.value);
      coreSel.disabled = !emuId;
      coreInput.hidden = true;
    }
    if (f === "coreSel") {
      if (coreSel.value === "__other") {
        coreInput.hidden = false;
        coreInput.focus();
        return;
      }
      coreInput.value = coreSel.value;
      coreInput.hidden = true;
    }
    await commitRow(tr);
  });
  $(".platforms").addEventListener("click", async (e) => {
    if (!e.target.matches("[data-browse]")) return;
    const tr = e.target.closest("tr");
    const dir = await api("dialog:pickFolder");
    if (dir) {
      $('[data-f="folder"]', tr).value = dir;
      await commitRow(tr);
    }
  });
  $(".platforms tr.focus")?.scrollIntoView({ block: "center" });
}

/** Whether an emulator is RetroArch-like (gets a suggested core even before its cores are found). */
function saveModeOrRetro(emuId) {
  const e = state.config.emulators.find((x) => x.id === emuId);
  return !!e && (/retroarch/i.test(e.path || "") || /retroarch/i.test(e.name) || /\{core\}/.test(e.args));
}


function renderAppearance() {
  const theme = state.config.theme || "system";
  $("#tab-body").innerHTML = `
    <div class="form">
      <label>Theme</label>
      <div class="row">${[["system", "Auto (follow Windows)"], ["light", "Light"], ["dark", "Dark"]].map(([v, l]) => `
        <label style="margin-right:14px"><input type="radio" name="theme" value="${v}" ${theme === v ? "checked" : ""}> ${l}</label>`).join("")}</div>
      <label></label><div class="hint">Auto switches with Windows' light/dark mode (Settings → Personalisation → Colours).</div>
    </div>`;
  $$('[name="theme"]').forEach((r) => r.addEventListener("change", () => save({ theme: r.value }, true)));
}

async function renderStorage() {
  const c = state.config;
  const info = await api("cache:info");
  const where = await api("app:paths").catch(() => null);
  $("#tab-body").innerHTML = `
    <div class="form">
      ${where?.canSwitch ? `<label>Launcher data</label><div>
        <label style="display:block"><input type="radio" name="g-where" value="local" ${where.portable ? "checked" : ""}> Next to RomM-Launcher.exe (recommended) <span class="muted">${esc(where.local)}</span></label>
        <label style="display:block;margin-top:4px"><input type="radio" name="g-where" value="appdata" ${where.portable ? "" : "checked"}> In AppData <span class="muted">${esc(where.appData)}</span></label></div>
      <label></label><div class="hint">Settings, the encrypted login, the downloaded-games list and save-sync records. Next to the exe, overwriting RomM-Launcher.exe with a new version keeps everything${where.portable ? `, and relative paths (here, in Emulators and in Platforms) are relative to <code>${esc(where.baseDir)}</code>` : ""}. Changing it copies them over and restarts the launcher; you sign in again.</div>`
      : where ? `<label>Launcher data</label><div class="hint">${esc(where.dataDir)}</div>` : ""}
      <label>Game download folder</label><div class="row"><input id="g-dir" value="${esc(c.romDir)}"><button id="g-browse">Browse…</button></div>
      <label>Emulator folder</label><div class="row"><input id="g-emudir" value="${esc(c.emulatorDir || "emulators")}"><button id="g-browse-emu">Browse…</button></div>
      <label></label><div class="hint">Where Settings → Emulators downloads emulators, one folder each. Emulators already there stay where they are.</div>
      <label></label><div class="hint">Games are kept here after the first play so they start instantly next time. Currently ${info.romCount} games, ${fmtBytes(info.romBytes)}.</div>
      <label>Multi-file games</label><div>
        <label style="display:block"><input type="radio" name="g-layout" value="subfolder" ${c.multiFileLayout !== "flat" ? "checked" : ""}> In a folder named after the game <span class="muted">roms\\psx\\Game (USA)\\…</span></label>
        <label style="display:block;margin-top:4px"><input type="radio" name="g-layout" value="flat" ${c.multiFileLayout === "flat" ? "checked" : ""}> Flat, straight in the platform folder <span class="muted">roms\\psx\\…</span></label></div>
      <label></label><div class="hint">Applies to games downloaded from now on. Flat: two games whose files have the same name (for example <code>disc1.bin</code>) would overwrite each other.</div>
      <label>Games per page</label><input id="g-page" type="number" min="20" max="500" value="${c.pageSize}">
      <label></label><label><input type="checkbox" id="g-min" ${c.minimizeOnLaunch ? "checked" : ""}> Minimize the launcher while a game is running</label>
      <label>Versions</label><label><input type="checkbox" id="g-group" ${c.groupVersions ? "checked" : ""}> One card per game; other versions (regions, revisions) are chosen when playing</label>
      <label>Play time</label><label><input type="checkbox" id="g-playtime" ${c.reportPlayTime !== false ? "checked" : ""}> Send play sessions to RomM, which shows play time per game (RomM 5.5 or later; sent later when played offline)</label>
      <label>Save sync</label><div>
        <label style="display:block"><input type="radio" name="g-sync" value="off" ${!c.syncSaves ? "checked" : ""}> Off</label>
        <label style="display:block;margin-top:4px"><input type="radio" name="g-sync" value="romm" ${c.syncSaves && c.saveBackend !== "webdav" ? "checked" : ""}> RomM — each game's saves, matched to the game</label>
        <label style="display:block;margin-top:4px"><input type="radio" name="g-sync" value="webdav" ${c.syncSaves && c.saveBackend === "webdav" ? "checked" : ""}> WebDAV (Nextcloud…) — the save folders of each emulator, chosen in Settings → Emulators</label></div>
      <label class="sync-romm">Save folder</label><div class="row sync-romm"><input id="g-saves" value="${esc(c.saveDir)}"><button id="g-browse-saves">Browse…</button></div>
      <label class="sync-romm"></label><div class="hint sync-romm">Synced saves live here, one folder per game, and are kept when you delete a game's local copy.
        Every local save is backed up to <code>.backups</code> before a newer server copy replaces it.</div>
      <label class="sync-webdav">WebDAV address</label><input class="sync-webdav" id="g-dav-url" value="${esc(c.webdav?.url ?? "")}" placeholder="https://cloud.example.com/remote.php/dav/files/USERNAME">
      <label class="sync-webdav">Username</label><input class="sync-webdav" id="g-dav-user" value="${esc(c.webdav?.username ?? "")}" autocomplete="off">
      <label class="sync-webdav">Password</label><input class="sync-webdav" id="g-dav-pass" type="password" autocomplete="new-password" placeholder="${c.hasWebdavPassword ? "(saved — leave empty to keep)" : "For Nextcloud, an app password (Settings → Security)"}">
      <label class="sync-webdav">Folder</label><input class="sync-webdav" id="g-dav-folder" value="${esc(c.webdav?.folder ?? "RomM Launcher Saves")}">
      <label class="sync-webdav"></label><div class="row sync-webdav"><button id="g-dav-test">Save &amp; test connection</button><button id="g-dav-sync">Sync all now</button><span id="g-dav-result" class="muted"></span></div>
      <label class="sync-webdav"></label><div class="hint sync-webdav">Each emulator's save folders are mirrored to <code>&lt;folder&gt;/&lt;emulator&gt;/&lt;save folder&gt;</code>,
        before a game starts and after it closes. Nothing is deleted on either side. When a file changed both here and on WebDAV,
        you are asked which to keep; the other copy goes to <code>save-backups</code> in the launcher's data folder.</div>
      <label>Cover image cache</label><div class="row"><span>${fmtBytes(info.imageBytes)}</span><button id="g-clear">Clear</button></div>
      <label></label><div class="row"><button class="primary" id="g-save">Save</button></div>
    </div>`;
  $("#g-browse-emu").addEventListener("click", async () => {
    const dir = await api("dialog:pickFolder");
    if (dir) $("#g-emudir").value = dir;
  });
  $("#g-browse").addEventListener("click", async () => {
    const dir = await api("dialog:pickFolder");
    if (dir) $("#g-dir").value = dir;
  });
  $("#g-clear").addEventListener("click", async () => { await api("cache:clearImages"); renderStorage(); toast("Image cache cleared", "ok"); });
  $$('[name="g-where"]').forEach((r) => r.addEventListener("change", async () => {
    const toLocal = r.value === "local";
    const where = toLocal ? "next to RomM-Launcher.exe" : "in AppData";
    if (!confirm(`Keep the launcher's data ${where}?\n\nSettings, downloaded-games list and save-sync records are copied there and the launcher restarts. You will sign in again.`)) {
      renderStorage();
      return;
    }
    try {
      await api("app:setDataLocation", toLocal);
    } catch (error) {
      toast(error.message, "error");
      renderStorage();
    }
  }));
  const syncMode = () => $('[name="g-sync"]:checked')?.value ?? "off";
  const showSyncFields = () => {
    $$(".sync-romm").forEach((el) => (el.hidden = syncMode() !== "romm"));
    $$(".sync-webdav").forEach((el) => (el.hidden = syncMode() !== "webdav"));
  };
  showSyncFields();
  $$('[name="g-sync"]').forEach((r) => r.addEventListener("change", showSyncFields));
  const webdavPatch = () => {
    const patch = {
      syncSaves: syncMode() !== "off",
      saveBackend: syncMode() === "webdav" ? "webdav" : "romm",
      webdav: { url: $("#g-dav-url").value.trim(), username: $("#g-dav-user").value.trim(), folder: $("#g-dav-folder").value.trim() || "RomM Launcher Saves" },
    };
    if ($("#g-dav-pass").value) patch.webdavPassword = $("#g-dav-pass").value;
    return patch;
  };
  $("#g-dav-test").addEventListener("click", async () => {
    await save(webdavPatch(), true);
    $("#g-dav-pass").value = "";
    $("#g-dav-result").textContent = "Testing…";
    try {
      await api("saves:testWebdav");
      $("#g-dav-result").innerHTML = '<span style="color:var(--ok)">✓ Connected</span>';
    } catch (error) {
      $("#g-dav-result").innerHTML = `<span style="color:var(--danger)">✕ ${esc(error.message)}</span>`;
    }
  });
  $("#g-dav-sync").addEventListener("click", async (e) => {
    await save(webdavPatch(), true);
    e.target.disabled = true;
    $("#g-dav-result").textContent = "Syncing…";
    try {
      const lines = await api("saves:syncAll");
      $("#g-dav-result").textContent = lines.length ? lines.join(" · ") : "No emulator has a save folder to sync.";
    } catch (error) {
      $("#g-dav-result").textContent = error.message;
    } finally {
      e.target.disabled = false;
    }
  });
  $("#g-save").addEventListener("click", () => save({
    ...webdavPatch(),
    romDir: $("#g-dir").value.trim(),
    emulatorDir: $("#g-emudir").value.trim() || "emulators",
    pageSize: Math.max(20, Math.min(500, Number($("#g-page").value) || 60)),
    minimizeOnLaunch: $("#g-min").checked,
    reportPlayTime: $("#g-playtime").checked,
    groupVersions: $("#g-group").checked,
    multiFileLayout: $('[name="g-layout"]:checked')?.value === "flat" ? "flat" : "subfolder",
    saveDir: $("#g-saves").value.trim(),
  }));
  $("#g-browse-saves").addEventListener("click", async () => {
    const dir = await api("dialog:pickFolder");
    if (dir) $("#g-saves").value = dir;
  });
}

// ------------------------------------------------------------------ tools: MAME names

// Full MAME descriptions by default, e.g. "Dynamite Cop (Export, Model 2B)".
const mame = { path: "", clean: false, tags: { kind: true, mechanical: true, status: true }, plan: null, platformId: null, busy: false };

window.romm.onToolProgress((ev) => {
  const el = $("#t-progress");
  if (!el) return;
  el.hidden = false;
  el.innerHTML = `<div class="meta" style="margin-bottom:5px">${esc(ev.label)}</div>
    <div class="track ${ev.fraction > 0 ? "" : "indet"}"><i style="width:${Math.round(ev.fraction * 100)}%"></i></div>`;
});

async function renderTools() {
  const arcade = state.platforms.find((p) => /^(mame|arcade|fbneo|neogeo|cps)/i.test(p.slug));
  mame.platformId ??= arcade?.id ?? state.platforms[0]?.id ?? null;
  const undo = await api("tools:mameUndoInfo").catch(() => null);
  $("#tab-body").innerHTML = `
    <h2 style="margin-top:0">Rename games from a MAME XML</h2>
    <div class="hint" style="margin-bottom:14px;max-width:820px">Matches each game's file name (e.g. <code>sf2.zip</code>) to a MAME XML or DAT
      (<code>mame -listxml</code>, or a DAT from your ROM set) and sets the RomM name from its description, e.g.
      <i>sf2</i> → <i>Street Fighter II: The World Warrior (World 910522)</i>. You see every change before anything is written.
      Names change on the server, for every user. A later RomM metadata update may set them again.</div>
    <div class="form">
      <label>Platform</label>
      <select id="t-platform">${state.platforms.map((p) => `<option value="${p.id}" ${p.id === mame.platformId ? "selected" : ""}>${esc(p.name)} (${p.romCount})</option>`).join("")}</select>
      <label>MAME XML / DAT</label><div class="row"><input id="t-file" value="${esc(mame.path)}" placeholder="Choose a file…" readonly><button id="t-browse">Browse…</button></div>
      <label></label><label><input type="checkbox" id="t-clean" ${mame.clean ? "checked" : ""}> Shorten names: remove details in brackets at the end, e.g. "(World 910522)"</label>
      <label></label><div class="hint" style="margin-top:-6px">Kept where they tell sets apart: if several games would end up with the same name,
        the parent set gets the short name and its clones keep the full one. Off by default: games get the full MAME name.</div>
      <label>Add MAME tags</label>
      <div class="row" style="flex-wrap:wrap;gap:6px 16px">
        <label><input type="checkbox" data-tag="kind" ${mame.tags.kind ? "checked" : ""}> (Parent) / (Clone) / (BIOS) / (Device)</label>
        <label><input type="checkbox" data-tag="mechanical" ${mame.tags.mechanical ? "checked" : ""}> (Mechanical)</label>
        <label><input type="checkbox" data-tag="status" ${mame.tags.status ? "checked" : ""}> (Working) / (Imperfect) / (Not Working)</label>
      </div>
      <label></label><div class="hint" style="margin-top:-6px">Appended to the name, e.g. <i>Street Fighter III: New Generation (Europe 970204) (Parent) (Working)</i>.
        Mechanical and emulation status need a <code>mame -listxml</code> file; many DATs leave them out.</div>
      <label></label><div class="row"><button class="primary" id="t-preview" ${mame.busy ? "disabled" : ""}>Preview changes</button></div>
    </div>
    <div class="progress" id="t-progress" style="margin:14px 0;max-width:760px" hidden></div>
    <div id="t-result"></div>
    ${undo ? `<div class="emu" style="margin-top:22px;max-width:760px"><b>Last rename:</b> ${undo.count} games on ${esc(new Date(undo.at).toLocaleString())}
      <button id="t-undo" style="margin-left:10px">Undo</button><div class="hint">Puts back the names those games had before.</div></div>` : ""}`;

  $("#t-platform").addEventListener("change", (e) => { mame.platformId = Number(e.target.value); mame.plan = null; $("#t-result").innerHTML = ""; });
  $("#t-clean").addEventListener("change", (e) => { mame.clean = e.target.checked; });
  $$("[data-tag]").forEach((cb) => cb.addEventListener("change", () => { mame.tags[cb.dataset.tag] = cb.checked; }));
  $("#t-browse").addEventListener("click", async () => {
    const path = await api("tools:pickMameXml");
    if (path) { mame.path = path; $("#t-file").value = path; }
  });
  $("#t-preview").addEventListener("click", previewRenames);
  $("#t-undo")?.addEventListener("click", async () => {
    if (!confirm(`Put back the previous names of ${undo.count} games on the server?`)) return;
    try {
      const r = await api("tools:mameUndo");
      toast(`Restored ${r.restored} names${r.failed ? `, ${r.failed} failed` : ""}.`, r.failed ? "error" : "ok");
    } catch (error) {
      toast(error.message, "error");
    }
    $("#t-progress").hidden = true;
    renderTools();
  });
  if (mame.plan) renderPlan();
}

async function previewRenames() {
  if (!mame.path) return toast("Choose a MAME XML or DAT file first.", "error");
  mame.busy = true;
  $("#t-preview").disabled = true;
  $("#t-result").innerHTML = "";
  try {
    mame.plan = await api("tools:mamePlan", mame.platformId, mame.path, mame.clean, Object.keys(mame.tags).filter((k) => mame.tags[k]));
    mame.plan.rows.forEach((r) => (r.selected = true));
    renderPlan();
  } catch (error) {
    $("#t-result").innerHTML = `<div class="emu" style="color:var(--danger)">${esc(error.message)}</div>`;
  } finally {
    mame.busy = false;
    if ($("#t-preview")) $("#t-preview").disabled = false;
    if ($("#t-progress")) $("#t-progress").hidden = true;
  }
}

function renderPlan() {
  const p = mame.plan;
  const box = $("#t-result");
  if (!box) return;
  const clones = p.rows.filter((r) => r.clone).length;
  box.innerHTML = `
    <div class="emu" style="max-width:none">
      <div><b>${p.games}</b> games on the platform · <b>${p.matched}</b> found in the file (${p.machinesInFile} entries) ·
        ${p.unchanged} already have that name · <b>${p.rows.length}</b> to rename${p.games - p.matched ? ` · ${p.games - p.matched} not in the file (left alone)` : ""}</div>
      ${(() => {
        const gaps = [];
        if (mame.tags.mechanical && !p.features?.mechanical) gaps.push("(Mechanical)");
        if (mame.tags.status && !p.features?.driverStatus) gaps.push("(Working) / (Imperfect) / (Not Working)");
        if (mame.tags.kind && !p.features?.device) gaps.push("(Device)");
        return gaps.length ? `<div class="hint" style="margin-top:4px">This file has no information for ${gaps.join(", ")}, so those tags are not added. A <code>mame -listxml</code> file has it.</div>` : "";
      })()}
      ${p.rows.length ? `
      <div class="row" style="margin:12px 0">
        <input id="t-filter" type="search" placeholder="Filter…" style="max-width:260px">
        <button id="t-all">Select all</button><button id="t-none">Select none</button>
        ${clones ? `<button id="t-noclones">Unselect ${clones} clones</button>` : ""}
        <div class="spacer"></div>
        <button class="primary" id="t-apply"></button>
      </div>
      <div style="max-height:55vh;overflow:auto;border:1px solid var(--line);border-radius:8px">
      <table class="platforms" id="t-table">
        <thead><tr><th style="width:34px"></th><th style="width:16%">File</th><th style="width:30%">Current name</th><th>New name (editable)</th><th style="width:60px">Year</th></tr></thead>
        <tbody>${p.rows.map((r, i) => `<tr data-i="${i}" data-search="${esc((r.file + " " + r.current + " " + r.proposed).toLowerCase())}">
          <td><input type="checkbox" data-sel ${r.selected ? "checked" : ""}></td>
          <td><code>${esc(r.file)}</code>${r.clone ? ' <span class="hint">clone</span>' : ""}</td>
          <td class="muted">${esc(r.current)}</td>
          <td><input data-name value="${esc(r.proposed)}" title="${esc(r.description)}"></td>
          <td class="hint">${esc(r.year)}</td></tr>`).join("")}</tbody>
      </table></div>` : ""}
    </div>`;
  if (!p.rows.length) return;
  const count = () => {
    const n = p.rows.filter((r) => r.selected).length;
    $("#t-apply").textContent = `Rename ${n} game${n === 1 ? "" : "s"} on the server`;
    $("#t-apply").disabled = n === 0;
  };
  count();
  const table = $("#t-table");
  table.addEventListener("change", (e) => {
    const r = p.rows[Number(e.target.closest("tr").dataset.i)];
    if (e.target.matches("[data-sel]")) r.selected = e.target.checked;
    if (e.target.matches("[data-name]")) r.proposed = e.target.value;
    count();
  });
  const setAll = (fn) => {
    $$("#t-table tbody tr").forEach((tr) => {
      if (tr.hidden) return;
      const r = p.rows[Number(tr.dataset.i)];
      r.selected = fn(r);
      $("[data-sel]", tr).checked = r.selected;
    });
    count();
  };
  $("#t-all").addEventListener("click", () => setAll(() => true));
  $("#t-none").addEventListener("click", () => setAll(() => false));
  $("#t-noclones")?.addEventListener("click", () => setAll((r) => r.selected && !r.clone));
  $("#t-filter").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    $$("#t-table tbody tr").forEach((tr) => (tr.hidden = !!q && !tr.dataset.search.includes(q)));
  });
  $("#t-apply").addEventListener("click", async () => {
    const rows = p.rows.filter((r) => r.selected && r.proposed.trim() && r.proposed.trim() !== r.current);
    if (!rows.length) return;
    if (!confirm(`Rename ${rows.length} games on your RomM server?\n\nThis changes the names for every user. The previous names are saved, and "Undo" puts them back.`)) return;
    $("#t-apply").disabled = true;
    try {
      const result = await api("tools:mameApply", rows.map((r) => ({ id: r.id, current: r.current, proposed: r.proposed })));
      const failed = result.failed.length;
      toast(`Renamed ${result.renamed} games${failed ? `; ${failed} failed (${result.failed[0].error})` : ""}.`, failed ? "error" : "ok");
      mame.plan = null;
    } catch (error) {
      toast(error.message, "error");
    }
    renderTools();
  });
}

// ------------------------------------------------------------------ boot

(async function boot() {
  state.config = await api("config:get");
  state.lastVersions = await api("versions:last").catch(() => ({}));
  if (state.config.checkUpdates !== false) void checkUpdates(true);
  if (!state.config.serverUrl) {
    openSettings("server");
    $("#platforms").innerHTML = '<div class="muted pad">Not connected</div>';
    return;
  }
  // The sort chosen last time, if the menu still offers it.
  if ([...$("#sort").options].some((o) => o.value === state.config.sort)) {
    state.sort = state.config.sort;
    $("#sort").value = state.sort;
  }
  if (!(await api("connection:check").catch(() => false))) {
    $("#platforms").innerHTML = '<div class="muted pad">Offline</div>';
    state.online = true;
    setOnline(false);
    return;
  }
  state.online = true;
  void refreshUser();
  loadSidebar();
  setView({ kind: "all", title: "All games" });
})();

// Broken cover → drop it and fall back to the title text (inline onerror is blocked by CSP).
document.addEventListener("error", (e) => {
  if (e.target instanceof HTMLImageElement) {
    const cover = e.target.closest(".card .cover");
    e.target.remove();
    if (cover) {
      const card = cover.closest(".card");
      const span = cover.querySelector("span");
      if (span && card) span.textContent = card.querySelector(".title")?.textContent ?? "";
    }
  }
}, true);
