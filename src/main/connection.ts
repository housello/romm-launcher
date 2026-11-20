// Whether the RomM server can be reached, so the launcher can fall back to the
// games it has downloaded instead of waiting on requests that cannot succeed.
//
// A quick heartbeat decides it at start and every RECHECK_MS while offline. Any
// request that fails to reach the server also flips it to offline, so a server
// that goes away mid-session is noticed at once.

import { ApiError, apiFetch } from "./api";
import { loadConfig } from "./config";

const CHECK_TIMEOUT_MS = 4_000;
const RECHECK_MS = 20_000;

type Listener = (online: boolean) => void;

let online = true;
let recheck: NodeJS.Timeout | null = null;
const listeners = new Set<Listener>();

export const isOffline = (): boolean => !online;

/** Called with the new state whenever it flips. */
export function onConnectionChange(listener: Listener): void {
  listeners.add(listener);
}

function setOnline(next: boolean): void {
  if (!next && !recheck) recheck = setInterval(() => void checkServer(), RECHECK_MS);
  if (next && recheck) {
    clearInterval(recheck);
    recheck = null;
  }
  if (next === online) return;
  online = next;
  console.info(`[connection] ${next ? "online" : "offline"}`);
  for (const listener of listeners) listener(next);
}

/** A failure to reach the server at all (no answer), as opposed to an HTTP error. */
export function isUnreachable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 0 && !!loadConfig().serverUrl
    && !/No RomM server configured|Refusing off-server URL/.test(error.message);
}

/** Note a request's failure: an unreachable server means offline. */
export function noteFailure(error: unknown): void {
  if (isUnreachable(error)) setOnline(false);
}

/** Ask the server whether it is there; any HTTP answer counts as reachable. */
export async function checkServer(): Promise<boolean> {
  if (!loadConfig().serverUrl) return online;
  try {
    await apiFetch("/api/heartbeat", { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    setOnline(true);
  } catch (error) {
    // A refused login is still a server that answers.
    setOnline(error instanceof ApiError && error.status > 0);
  }
  return online;
}
