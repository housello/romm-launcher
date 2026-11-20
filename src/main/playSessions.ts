// Play time reported to RomM (POST /api/play-sessions, RomM 5.5+), so the server
// shows how long and when each game was played, as for games played in the browser.
// Sessions wait in play-sessions.json until RomM takes them: played offline, they
// go up once it is reachable. RomM reports a session it already has as a duplicate,
// so sending one twice is harmless.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError, apiFetch } from "./api";
import { loadConfig } from "./config";
import { isOffline, noteFailure } from "./connection";
import { dataDir } from "./paths";

/** Shorter plays (a wrong emulator, a quick check) are not worth recording. */
const MIN_SECONDS = 30;
const BATCH = 100;

interface PendingSession {
  romId: number;
  start: number;
  end: number;
}

const file = () => join(dataDir(), "play-sessions.json");

function load(): PendingSession[] {
  try {
    return existsSync(file()) ? (JSON.parse(readFileSync(file(), "utf8")) as PendingSession[]) : [];
  } catch {
    return [];
  }
}

function save(list: PendingSession[]): void {
  writeFileSync(`${file()}.tmp`, JSON.stringify(list));
  renameSync(`${file()}.tmp`, file());
}

/** Queue one play of a game and try to send it. */
export function recordSession(romId: number, start: number, end: number): void {
  if (!loadConfig().reportPlayTime || (end - start) / 1000 < MIN_SECONDS) return;
  save([...load(), { romId, start, end }]);
  void flushSessions();
}

let flushing: Promise<void> | null = null;

/** Send the queued sessions; those RomM cannot take stay queued for the next try. */
export function flushSessions(): Promise<void> {
  flushing ??= send().finally(() => {
    flushing = null;
  });
  return flushing;
}

async function send(): Promise<void> {
  let queue = load();
  while (queue.length && !isOffline()) {
    const batch = queue.slice(0, BATCH);
    let response: Response;
    try {
      response = await apiFetch("/api/play-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessions: batch.map((s) => ({
            rom_id: s.romId,
            start_time: new Date(s.start).toISOString(),
            end_time: new Date(s.end).toISOString(),
            duration_ms: s.end - s.start,
          })),
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      noteFailure(error);
      if (error instanceof ApiError && error.status) console.error("[play-sessions]", error.message);
      return;
    }
    if (response.status === 404) {
      // A RomM older than 5.5 has nowhere to put them.
      console.info("[play-sessions] this RomM does not take play sessions; dropping the queue");
      save([]);
      return;
    }
    if (!response.ok) {
      console.error(`[play-sessions] HTTP ${response.status}; kept for the next try`);
      return;
    }
    // Created, duplicate and rejected (e.g. a game since deleted) all leave the queue.
    queue = queue.slice(batch.length);
    save(queue);
  }
}
