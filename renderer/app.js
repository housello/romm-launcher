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
    const [platforms, collections] = await Promise.all([api("platforms:list"), api("collections:list")]);
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
  $("#collections-title").hidden = state.collections.length === 0;
  $("#collections").innerHTML = state.collections.map((c) => `
    <a class="nav-item" data-collection="${c.id}"><span class="name">${esc(c.name)}</span><span class="count">${c.romCount || ""}</span></a>`).join("");
  markActive();
}

function markActive() {
  $$(".nav-item").forEach((a) => a.classList.remove("active"));
  const v = state.view;
  const sel = v.kind === "platform" ? `[data-platform="${v.id}"]` : v.kind === "collection" ? `[data-collection="${v.id}"]` : `[data-view="${v.kind}"]`;
  $(sel)?.classList.add("active");
}

$("#sidebar").addEventListener("click", (e) => {
  const a = e.target.closest(".nav-item");
  if (!a) return;
  if (a.dataset.view === "settings") return openSettings();
  if (a.dataset.view) setView({ kind: a.dataset.view, title: a.textContent.trim() });
  if (a.dataset.platform) {
    const p = state.platforms.find((x) => x.id === Number(a.dataset.platform));
    setView({ kind: "platform", id: p.id, title: p.name, slug: p.slug });
  }
  if (a.dataset.collection) {
    const c = state.collections.find((x) => x.id === Number(a.dataset.collection));
    setView({ kind: "collection", id: c.id, title: c.name });
  }
});

// ------------------------------------------------------------------ grid

function setView(view, search = "") {
  state.view = view;
  // Each view starts unfiltered, unless the sidebar search sent us here.
  state.search = search;
  $("#view-search").value = search;
  if (view.kind !== "all") $("#search").value = "";
  $("#view-search").placeholder = `Search in ${view.title}…`;
  $("#settings").hidden = true;
  $("#content").hidden = false;
  $("#toolbar").hidden = false;
  $("#view-title").textContent = view.title;
  markActive();
  reload();
}

function reload() {
  state.gen++;
  // A request from the previous view may still be in flight; it is ignored when it
  // lands (its gen no longer matches), so it must not keep this view from loading.
  state.loading = false;
  state.offset = 0;
  state.done = false;
  state.total = 0;
  state.seen = new Set(); // ids already shown, including folded versions
  state.items = new Map(); // id -> list item, for the version chooser
  $("#grid").innerHTML = "";
  $("#empty").hidden = true;
  $("#view-count").textContent = "";
  $("#content").scrollTop = 0;
  if (state.view.kind === "installed") return renderInstalled();
  loadMore();
}

async function loadMore() {
  if (state.loading || state.done || state.view.kind === "installed") return;
  state.loading = true;
  const gen = state.gen;
  const [orderBy, orderDir] = state.sort.split(":");
  const params = { offset: state.offset, limit: state.config.pageSize || 60, search: state.search, orderBy, orderDir };
  if (state.view.kind === "platform") params.platformId = state.view.id;
  if (state.view.kind === "collection") params.collectionId = state.view.id;
  if (state.view.kind === "favourites") params.favourite = true;
  const firstPage = state.offset === 0;
  if (firstPage) showLoading();
  try {
    const page = await api("roms:list", params);
    if (gen !== state.gen) return;
    if (firstPage) $("#empty").hidden = true;
    state.total = page.total;
    state.offset += page.items.length;
    state.done = page.items.length === 0 || state.offset >= page.total;
    // Fold versions client-side too, for servers that ignore group_by_meta_id.
    const fresh = page.items.filter((item) => {
      if (state.seen.has(item.id)) return false;
      state.seen.add(item.id);
      for (const v of item.versions) state.seen.add(v.id);
      state.items.set(item.id, item);
      return true;
    });
    $("#grid").insertAdjacentHTML("beforeend", fresh.map(cardHtml).join(""));
    $("#view-count").textContent = `${page.total} games`;
    if (state.offset === 0) showEmpty(state.search ? "No games match your search." : "Nothing here.");
  } catch (error) {
    if (gen !== state.gen) return;
    state.done = true;
    if (state.offset === 0) showEmpty(error.message, true, true);
    else toast(`Could not load more games: ${error.message}`, "error");
  } finally {
    if (gen === state.gen) state.loading = false;
  }
  // Keep filling if the sentinel is still visible (big screens).
  if (gen === state.gen && !state.done && isSentinelVisible()) loadMore();
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

function isSentinelVisible() {
  const r = $("#sentinel").getBoundingClientRect();
  return r.top < window.innerHeight + 600;
}

new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting)) loadMore();
}, { root: $("#content"), rootMargin: "800px" }).observe($("#sentinel"));

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
  const play = e.target.closest("[data-play]");
  if (play) {
    e.stopPropagation();
    const item = state.items?.get(Number(play.dataset.play));
    if (item?.versions?.length > 1) return chooseVersion(item, "Play").then((id) => id && playGame(id));
    return playGame(Number(play.dataset.play));
  }
  const card = e.target.closest(".card");
  if (card) openDetail(Number(card.dataset.id));
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
$("#sort").addEventListener("change", () => { state.sort = $("#sort").value; reload(); });
$("#zoom").addEventListener("input", () => document.documentElement.style.setProperty("--card", $("#zoom").value + "px"));
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

function refreshJob(id) {
  const card = $(`.card[data-id="${id}"]`);
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
          <span class="lbl">${esc(v.fileName || v.name)}</span>${v.installed ? '<span class="chip">✓ downloaded</span>' : ""}</div>`).join("")}</div>
        <div class="hint">Play / Download apply to the highlighted version.</div>` : ""}
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

function savesHtml(r) {
  const rows = [...r.saves.map((s) => ({ ...s, kind: "Save" })), ...r.states.map((s) => ({ ...s, kind: "State" }))]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const status = !r.syncSaves ? "Save sync is turned off (Settings → Storage)."
    : r.saveMode === "off" ? "Save sync is off for this emulator (Settings → Emulators)."
    : "Pulled before each launch, uploaded when the emulator closes.";
  return `<h3>Saves on RomM</h3>
    <div class="hint" style="margin-bottom:6px">${esc(status)}</div>
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
    ${r.installed && !busy && !running && r.syncSaves && r.saveMode !== "off" ? '<button data-act="sync">⟳ Sync saves</button>' : ""}
    ${r.installed && !busy && !running ? '<button data-act="folder">Open folder</button><button class="danger" data-act="uninstall">Delete local copy</button>' : ""}
    <button data-act="web">Open in RomM</button>`;
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
  const version = e.target.closest("[data-version]");
  if (version) return openDetail(Number(version.dataset.version));
  const act = e.target.closest("[data-act]")?.dataset.act;
  const r = detailRom;
  if (!act || !r) return;
  try {
    if (act === "play") await playGame(r.id);
    if (act === "install") {
      state.jobs.set(r.id, { type: "progress", label: "Preparing…", received: 0, total: 0 });
      renderDetailActions();
      await api("game:install", r.id);
      toast(`${r.name} downloaded`, "ok");
    }
    if (act === "cancel" || act === "stop") await api("game:cancel", r.id);
    if (act === "folder") await api("game:openFolder", r.id);
    if (act === "sync") toast(await api("game:syncSaves", r.id), "ok");
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
  $("#settings").hidden = false;
  presets ??= await api("emulators:presets");
  state.config = await api("config:get");
  renderSettings(focusSlug);
}

function renderSettings(focusSlug) {
  const tabs = [["server", "Server"], ["emulators", "Emulators"], ["platforms", "Platforms"], ["storage", "Storage"], ["tools", "Tools"]];
  $("#settings").innerHTML = `
    <h1 style="margin-top:0">Settings</h1>
    <div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === settingsTab ? "active" : ""}">${l}</button>`).join("")}</div>
    <div id="tab-body"></div>`;
  ({ server: renderServer, emulators: renderEmulators, platforms: renderPlatforms, storage: renderStorage, tools: renderTools })[settingsTab](focusSlug);
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

function renderEmulators() {
  const c = state.config;
  $("#tab-body").innerHTML = `
    <div class="row" style="margin-bottom:14px">
      <select id="e-preset">${presets.presets.map((p) => `<option value="${p.key}">${esc(p.name)}</option>`).join("")}</select>
      <button class="primary" id="e-add">+ Add emulator</button>
      <button id="e-detect">Detect RetroArch</button>
    </div>
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
        <label>Executable</label><div class="row"><input data-f="path" value="${esc(e.path)}"><button data-browse>Browse…</button></div>
        <label>Arguments</label><input data-f="args" value="${esc(e.args)}">
        <label></label><label><input type="checkbox" data-f="extractZip" ${e.extractZip ? "checked" : ""}> Extract .zip games before launching</label>
        <label>Save sync</label>
        <select data-f="saveMode">
          <option value="off" ${modeOf(e) === "off" ? "selected" : ""}>Off</option>
          <option value="retroarch" ${modeOf(e) === "retroarch" ? "selected" : ""}>RetroArch (automatic)</option>
          <option value="custom" ${modeOf(e) === "custom" ? "selected" : ""}>Custom file patterns</option>
        </select>
        <label class="pat" ${modeOf(e) === "custom" ? "" : "hidden"}>Save files</label><input class="pat" data-f="savePattern" value="${esc(e.savePattern ?? "")}" placeholder="{romDir}/{romName}.sav" ${modeOf(e) === "custom" ? "" : "hidden"}>
        <label class="pat" ${modeOf(e) === "custom" ? "" : "hidden"}>State files</label><input class="pat" data-f="statePattern" value="${esc(e.statePattern ?? "")}" placeholder="{romDir}/{romName}.ss*" ${modeOf(e) === "custom" ? "" : "hidden"}>
      </div>
    </div>`).join(""));

  const commit = async () => {
    const emulators = $$(".emu").map((el) => ({
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
  $("#e-list").addEventListener("change", async (e) => {
    if (e.target.dataset.f === "saveMode") {
      const box = e.target.closest(".emu");
      $$(".pat", box).forEach((el) => (el.hidden = e.target.value !== "custom"));
    }
    await commit();
  });
  $("#e-list").addEventListener("click", async (e) => {
    const box = e.target.closest(".emu");
    if (e.target.matches("[data-del]")) {
      if (!confirm("Remove this emulator?")) return;
      box.remove();
      await commit();
      return renderEmulators();
    }
    if (e.target.matches("[data-browse]")) {
      const path = await api("dialog:pickExe");
      if (path) { $('[data-f="path"]', box).value = path; await commit(); }
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
    const path = preset.key === "retroarch" ? (await api("emulators:detectRetroArch")) ?? "" : "";
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


async function renderStorage() {
  const c = state.config;
  const info = await api("cache:info");
  $("#tab-body").innerHTML = `
    <div class="form">
      <label>Game download folder</label><div class="row"><input id="g-dir" value="${esc(c.romDir)}"><button id="g-browse">Browse…</button></div>
      <label></label><div class="hint">Games are kept here after the first play so they start instantly next time. Currently ${info.romCount} games, ${fmtBytes(info.romBytes)}.</div>
      <label>Games per page</label><input id="g-page" type="number" min="20" max="500" value="${c.pageSize}">
      <label></label><label><input type="checkbox" id="g-min" ${c.minimizeOnLaunch ? "checked" : ""}> Minimize the launcher while a game is running</label>
      <label>Versions</label><label><input type="checkbox" id="g-group" ${c.groupVersions ? "checked" : ""}> One card per game; other versions (regions, revisions) are chosen when playing</label>
      <label>Save sync</label><label><input type="checkbox" id="g-sync" ${c.syncSaves ? "checked" : ""}> Sync saves and save states with RomM</label>
      <label>Save folder</label><div class="row"><input id="g-saves" value="${esc(c.saveDir)}"><button id="g-browse-saves">Browse…</button></div>
      <label></label><div class="hint">Synced saves live here, one folder per game, and are kept when you delete a game's local copy.
        Every local save is backed up to <code>.backups</code> before a newer server copy replaces it.</div>
      <label>Cover image cache</label><div class="row"><span>${fmtBytes(info.imageBytes)}</span><button id="g-clear">Clear</button></div>
      <label></label><div class="row"><button class="primary" id="g-save">Save</button></div>
    </div>`;
  $("#g-browse").addEventListener("click", async () => {
    const dir = await api("dialog:pickFolder");
    if (dir) $("#g-dir").value = dir;
  });
  $("#g-clear").addEventListener("click", async () => { await api("cache:clearImages"); renderStorage(); toast("Image cache cleared", "ok"); });
  $("#g-save").addEventListener("click", () => save({
    romDir: $("#g-dir").value.trim(),
    pageSize: Math.max(20, Math.min(500, Number($("#g-page").value) || 60)),
    minimizeOnLaunch: $("#g-min").checked,
    syncSaves: $("#g-sync").checked,
    groupVersions: $("#g-group").checked,
    saveDir: $("#g-saves").value.trim(),
  }));
  $("#g-browse-saves").addEventListener("click", async () => {
    const dir = await api("dialog:pickFolder");
    if (dir) $("#g-saves").value = dir;
  });
}

// ------------------------------------------------------------------ tools: MAME names

// Full MAME descriptions by default, e.g. "Dynamite Cop (Export, Model 2B)".
const mame = { path: "", clean: false, plan: null, platformId: null, busy: false };

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
      <label></label><div class="row"><button class="primary" id="t-preview" ${mame.busy ? "disabled" : ""}>Preview changes</button></div>
    </div>
    <div class="progress" id="t-progress" style="margin:14px 0;max-width:760px" hidden></div>
    <div id="t-result"></div>
    ${undo ? `<div class="emu" style="margin-top:22px;max-width:760px"><b>Last rename:</b> ${undo.count} games on ${esc(new Date(undo.at).toLocaleString())}
      <button id="t-undo" style="margin-left:10px">Undo</button><div class="hint">Puts back the names those games had before.</div></div>` : ""}`;

  $("#t-platform").addEventListener("change", (e) => { mame.platformId = Number(e.target.value); mame.plan = null; $("#t-result").innerHTML = ""; });
  $("#t-clean").addEventListener("change", (e) => { mame.clean = e.target.checked; });
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
    mame.plan = await api("tools:mamePlan", mame.platformId, mame.path, mame.clean);
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
  if (!state.config.serverUrl) {
    openSettings("server");
    $("#platforms").innerHTML = '<div class="muted pad">Not connected</div>';
    return;
  }
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
