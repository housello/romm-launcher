# RomM Launcher

A lightweight Windows client for a [RomM](https://github.com/rommapp/romm) server that
browses your library live and launches games in **your own locally installed emulators**.

Unlike the Playnite plugin, nothing is synced: the library is read from the RomM API
page by page as you scroll, so it opens in a couple of seconds whatever the size of
the collection. The only things stored locally are:

- `launcher-config.json`: server, emulators, platform mapping (no secrets)
- `credentials.dat`: the password / token, encrypted with Windows' data protection (not readable text)
- `installed.json`: the games you downloaded
- `last-versions.json`: the version of each game you played last
- `image-cache/`: cover art, so revisits are instant
- the downloaded games themselves (default `roms\<platform>\` next to the exe, configurable per platform)

## Install and update

Download `RomM-Launcher-x.y.z.zip` from the releases, unzip `RomM-Launcher.exe` into a folder of
its own and start it. To update, overwrite `RomM-Launcher.exe` with the new one: everything else
stays.

## Where the data lives

By default everything lives next to the exe, in a **`RomM Launcher Data`** folder: settings, the
encrypted login, the list of downloaded games, save-sync records and caches. Nothing is written
to AppData. Paths can be relative to the exe's folder, and the defaults are:

```
RomM-Launcher.exe
RomM Launcher Data\     settings, login, caches
roms\<platform>\...     downloaded games
saves\...               synced saves
```

Emulators, per-platform download folders and the save folder can be relative too (e.g.
`emulators\RetroArch\retroarch.exe`); **Browse…** stores a relative path automatically when you pick
something inside the launcher's folder. Downloaded games are recorded relative to it, so the folder
keeps working when it moves or the drive letter changes.

**Settings → Storage → Launcher data** moves it to `%APPDATA%\romm-launcher` instead (an
`appdata` file next to the exe records the choice), or back. The settings, downloaded-games list
and save-sync records are copied over with their paths adjusted, and the launcher restarts.

The login is never copied: it is encrypted per Windows user and data folder, so it is entered once
more after a move. For the same reason, on another PC or Windows account the launcher asks for the
password again; everything else carries over. Before 0.1.5 the data stayed in AppData unless a
`portable` file was next to the exe; the first start of 0.1.5 copies it next to the exe.

## Run

```powershell
npm install
npm run dev
```

Build `release/RomM-Launcher.exe` with `npm run package`. `npm run release` also zips it as
`release/RomM-Launcher-<version>.zip`.

## Setup

1. **Settings → Server**: URL, username/password (HTTP Basic) or a RomM client/API token. *Save & test.*
2. **Settings → Emulators**: add one from a preset (RetroArch, Dolphin, PCSX2, DuckStation, PPSSPP,
   RPCS3, Cemu, Ryujinx, Azahar, melonDS, mGBA, Flycast, xemu, Xenia, MAME, DOSBox, Custom),
   or click **Detect RetroArch**. Adding a preset automatically maps it to the platforms it
   usually runs (only those with no emulator yet).
3. **Settings → Platforms**: choose the emulator per platform, the libretro core
   (for RetroArch; ★ marks the suggested one), and if needed per-platform arguments and a
   download folder. The filter box and "only platforms without an emulator" help with long lists.

### Downloading emulators

In **Settings → Emulators**, **+ Add emulator** asks, for the emulators the launcher can fetch,
whether to **download** it or to **use one already on this PC** (pick its executable). Those it
can download, from their official releases: RetroArch, Dolphin, PCSX2, DuckStation, PPSSPP,
RPCS3, shadPS4, Vita3K, Cemu, Ryujinx (Ryubing), Azahar, melonDS, DeSmuME, mGBA, SameBoy, SkyEmu,
Gearboy, gopher64, Snes9x, bsnes, Mesen, ares, BizHawk, Gearsystem, Geargrafx, Stella, openMSX,
Flycast, xemu, Xenia Canary, MAME, Supermodel, FinalBurn Neo, DOSBox Staging and DOSBox-X.

- A download goes to `emulators\<name>\` next to the exe (Settings → Storage changes the folder),
  is added to your emulators and assigned to your platforms that have no emulator yet. Where the
  emulator supports it (Dolphin, PCSX2, DuckStation, Cemu, Ryujinx, Azahar, Xenia), it is set to
  keep its settings in its own folder.
- Its card shows the installed version, **Open folder**, and **Update** once a newer one is known.
  An update unpacks over the old version, so settings and saves in its folder stay. Close the
  emulator first.
- **Download cores** on RetroArch's card fetches the libretro cores your platforms use.
- **About → Emulator updates** checks all of them at once.

Zip, 7z and MAME's self-extracting archives are unpacked with Windows' own `tar`, so nothing extra
ships with the launcher.

Platforms without an emulator show an orange dot in the sidebar. Pressing Play on one
takes you straight to its row in the Platforms tab.

**Settings → Appearance** chooses the theme: **Auto** (follows Windows' light/dark mode and
switches with it), **Light** or **Dark**. It applies immediately, including scrollbars and dialogs.

### Argument placeholders

| Placeholder | Value |
| --- | --- |
| `{rom}` | full path of the game file to launch |
| `{romDir}` | its folder |
| `{romFile}` | file name with extension |
| `{romName}` | file name without extension |
| `{emuDir}` | folder of the emulator executable |
| `{core}` | core set for the platform (RetroArch: `-L "{emuDir}\cores\{core}_libretro.dll" "{rom}"`) |

Arguments are split like a Windows command line and substituted per argument, so paths
with spaces are safe as long as the template quotes them. `.bat`/`.cmd` wrappers also work.

## Playing

- **Play** downloads the game if needed (with progress), then starts the emulator.
  The launcher minimizes while you play and comes back when the emulator exits.
- **Multi-file games** are downloaded file by file, keeping their folder layout.
  Multi-disc sets with no playlist get an `.m3u` written automatically. Otherwise the
  launcher picks the most likely boot file (`.cue`, `.chd`, `.iso`, `EBOOT.BIN`, …).
  When a game has **several launchable files** (e.g. `GAME.EXE` and `SETUP.EXE`), the first
  Play asks which one to start and remembers the answer. Readmes, data files and cue-sheet
  tracks are not offered. You can change the chosen file later in the game's detail panel.
- **Versions**: RomM groups versions of the same game (regions, revisions) as *siblings*.
  The launcher shows one card per game, marked "N versions". The first Play asks which version
  to download and start, preselecting the one you already downloaded, and remembers it: later
  Plays start that version directly. Opening the game shows it, marked "last played"; to change
  version, pick another in the Versions list and press Play there. Turn grouping off in
  Settings → Storage to see every version as its own card.
- **Extract .zip games** (per emulator) unpacks zipped ROMs for emulators that cannot read
  archives. Only zip (store/deflate, no zip64) is supported, not 7z.
- **Downloaded** in the sidebar lists local games. Delete a local copy from the detail panel.
- **Favourites**: ☆/★ **Favourite** in a game's detail panel adds it to (or removes it from)
  your RomM favourites, the same Favourites collection the web interface uses; it is created if
  your user has none yet. The sort menu's **Favourites first** shows your favourites first, then
  all other games, each part A→Z.
- **Search**: the box above the grid (Ctrl+F) searches the current platform or collection;
  the sidebar box (Ctrl+Shift+F) searches the whole library.
- **Large libraries** load page by page as you scroll; the footer shows how much is loaded,
  has a **Load more** button, and shows an error with **Retry** if a page fails.
- **Filters** (toolbar): the RomM server's own filters for the current view. Yes/No switches
  (favourites, matched, played, has saves/states, RetroAchievements, duplicates, verified,
  missing files) and searchable lists filled from your library (genres, franchises, series,
  companies, developers, publishers, players, age ratings, regions, languages, your status,
  tags). Filters stay on when you switch platform; **Clear all** resets them.
- **Collections**: the **Collections** entry in the sidebar shows all your RomM collections as
  cards (cover, game count, private/public); click one to browse its games, use
  **+ New collection** to create one, and ✕ on your own collections to delete one (its games
  stay in the library). Right-click a game, or use **+ Add to collection** in its detail panel, to
  add it to one of your RomM collections or a new one (private or public). The detail panel
  lists the game's collections; ✕ removes it from one. Collections belong to the RomM user the
  launcher signs in with; public collections of other users are listed but read-only.
  **Smart collections** (RomM 5, built from filters) are listed too, marked *Smart*; their games
  follow their filters, so they are read-only here.
- **Sort and view**: the toolbar's sort menu, and covers (▦) or details (☰, one row per game),
  are remembered between starts.
- **Play time**: each play of 30 seconds or more is sent to RomM (5.5 or later) as a play
  session, so the server shows play time per game. Played offline, sessions wait and go up when
  RomM is reachable again. Turn it off in Settings → Storage.
- **Interrupted downloads** resume: the unfinished `.part` file is kept, and pressing Play (or
  Download) again fetches only the missing part.
- **Updates**: at start the launcher asks GitHub for a newer release and offers **Update and
  restart**, which downloads it, replaces `RomM-Launcher.exe` once the launcher has closed and
  starts the new one. **About**, in the menu bar, shows the version and turns the check off or
  runs it now.
- **Offline**: when RomM cannot be reached (checked at start, and whenever a request gets no
  answer), a banner says so and the launcher shows **Downloaded**. Those games still play, and
  their detail panel shows what RomM last said about them. Saves are used from this PC; the ones
  changed meanwhile upload by themselves once RomM answers again (checked every 20 seconds, or
  with **Retry now**). Collections, favourites and browsing the library need the server.

### Where games are downloaded

`<download folder>\<platform slug>\rom.ext`, with multi-file games in their own folder
(`<platform slug>\<game folder>\...`), the same layout as a RomM library. The download folder
is set in Settings → Storage; each platform can point somewhere else in Settings → Platforms.

Settings → Storage → **Multi-file games → Flat** puts a multi-file game's files straight in the
platform folder instead, without the game folder. A game whose files would replace a different
file another downloaded game uses (two games' `disc1.bin`) still gets its own folder. The choice
applies to games downloaded after it.

If a platform points at a folder that already holds your ROMs, a game whose file is already
there with the right size is used as-is, without downloading. **Delete local copy** only
removes files the launcher itself downloaded, never files that were already there.

### MAME sets with CHD disks

MAME looks for a set's disk images in a folder named after the set, next to the romset:
`sfiii.zip` + `sfiii\cap-sf3-3.chd`. RomM often keeps those folders apart (e.g. `roms/chd`), so
each CHD folder is a game of its own there. When an arcade romset (`.zip`/`.7z` on a `mame`,
`arcade`, `fbneo`, … platform) is downloaded, the launcher also fetches its CHD folder and puts
it next to the zip:

```
mame\sfiii.zip
mame\sfiiia.zip
mame\sfiii\cap-sf3-3.chd
```

The folder is found by name, as MAME does: the one named after the set, else, for a clone, the
longest folder name the set starts with (`sfiiia` → `sfiii`, `sfiii3jr1` → `sfiii3`). Games
downloaded before this existed get their CHD at their next launch. The CHD is never offered as
a file to launch, and a CHD shared by a parent and its clones is deleted only together with the
last downloaded game that uses it. Launching a CHD folder's own RomM entry is not supported:
play the romset.

## Save sync

On by default (Settings → Storage). With sync turned off, every emulator uses its own
native save folders and the launcher adds nothing to its command line. With sync on, for every launch:

1. **Before the emulator starts**, the newest save and states on RomM for that game are
   downloaded, if they changed since the last sync.
2. **After the emulator exits**, local saves/states that changed are uploaded.

How saves are found is set per emulator (Settings → Emulators → Save sync):

- **RetroArch (automatic)**: the launcher adds `--appendconfig` with a small config that
  points `savefile_directory` / `savestate_directory` at a per-game folder. Your
  `retroarch.cfg` is not touched. The libretro core name is used as RomM's `emulator`, so
  saves are compatible with RomM's in-browser player for the same core. Saves made
  *before* using this launcher are still in RetroArch's own folder: copy them once into the
  game's save folder if you want them synced.
- **Custom file patterns**: e.g. `{romDir}/{romName}.sav` (mGBA and melonDS presets come
  with this). Placeholders as for arguments, plus `{saveDir}`. `*` is allowed in the file name.
- **Off**: e.g. Dolphin, PCSX2 and PPSSPP, which keep saves in memory cards or by game ID
  rather than one file per game.

Synced saves live in the save folder (default `saves\<platform>\<romId>` next to the exe),
not in the game folder, so deleting a game's local copy keeps them. If a pattern points
inside the game folder, those saves are uploaded before the copy is deleted (and nothing is
deleted if the upload fails).

**No save is ever lost**: before a server copy replaces a local file, the local file is
copied to `.backups\` in the game's save folder (last 10 per file). When both sides changed,
the newer one wins and the other stays in the backups. The game page lists the saves
on RomM and has a **Sync saves** button.

Uses the `/api/saves` and `/api/states` endpoints (no device registration).

## Renaming arcade games from a MAME XML

Settings → Tools → **Rename games from a MAME XML** sets RomM's game names from a MAME
XML or DAT (`mame -listxml`, or the DAT that came with your ROM set), e.g. `sf2` →
*Street Fighter II: The World Warrior (World 910522)*.

1. Choose the platform and the file, then **Preview changes**. Each game's file name
   (`sf2.zip` → `sf2`) is looked up in the file; the XML is streamed, so a full
   several-hundred-MB `mame.xml` is fine.
2. Review the table: untick rows, edit a new name by hand, or **Unselect clones** to rename
   only parent sets. By default each game gets the full MAME description, brackets included,
   e.g. *Dynamite Cop (Export, Model 2B)*. The optional "Shorten names" removes trailing
   bracketed details, but only where the short name stays unique: when several sets would
   share it, the parent set gets the short name and the clones keep their full description.
3. **Rename** writes the names to the server (`PUT /api/roms/{id}` with only the `name` field;
   RomM keeps the old name as an alternative name). Games not in the file, or already named
   that way, are left alone.
4. **Undo** puts back the names of the last run; they are saved before anything is written.

Names change for every user of the server, and a later RomM *Update metadata* scan may replace
them with the metadata provider's titles. Renaming needs an account allowed to edit games.

### MAME tags in names

"Add MAME tags" appends what the XML says about each set to its name, in brackets:

| Group | Tags |
| --- | --- |
| Kind | (Parent), (Clone), (BIOS), (Device) |
| Mechanical | (Mechanical) |
| Emulation status | (Working), (Imperfect), (Not Working) |

e.g. *Street Fighter III: New Generation (Asia 970204) (Clone) (Imperfect)*. Each group can be
switched off. Mechanical sets and emulation status are only in a `mame -listxml` file; many DATs
leave them out (the tool says so).

These are part of the **name** only. RomM's own tags, regions and languages come from the brackets
in the *file name* (e.g. `Game (USA) [b].zip`), not from the game name, so they do not appear under
**Filters → Tags**. They are still searchable: type *Clone* or *Not Working* in the search box.

## Not included (yet)

Play-time reporting, 7z extraction, controller navigation, uploading saves while a game is
still running (only on exit).

`src/main/zip.ts` is copied from [rommapp/desktop](https://github.com/rommapp/desktop) (AGPL-3.0).
