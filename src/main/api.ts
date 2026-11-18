// Thin authenticated client for the RomM REST API. Every request goes through
// one Electron session so that TLS policy (self-signed certificates) and the
// auth header are applied in a single place.

import { session, type Session } from "electron";
import { getPassword, loadConfig } from "./config";

let romSession: Session | null = null;

export function apiSession(): Session {
  if (!romSession) {
    romSession = session.fromPartition("romm-api");
    romSession.setCertificateVerifyProc((request, callback) => {
      // -3 = use Chromium's verdict, 0 = accept.
      callback(loadConfig().allowSelfSigned ? 0 : -3);
    });
  }
  return romSession;
}

export function authHeaders(): Record<string, string> {
  const config = loadConfig();
  if (config.authType === "token" && config.token) return { Authorization: `Bearer ${config.token}` };
  if (config.authType === "basic" && config.username) {
    const raw = `${config.username}:${getPassword(config)}`;
    return { Authorization: `Basic ${Buffer.from(raw, "utf8").toString("base64")}` };
  }
  return {};
}

export class ApiError extends Error {
  constructor(message: string, public status = 0) {
    super(message);
  }
}

/** Resolve a server-relative path (or absolute URL on the same server). */
export function serverUrl(path: string): string {
  const base = loadConfig().serverUrl;
  if (!base) throw new ApiError("No RomM server configured. Open Settings.");
  const url = new URL(path, base + "/");
  if (url.origin !== new URL(base).origin) throw new ApiError(`Refusing off-server URL: ${url.origin}`);
  return url.toString();
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = serverUrl(path);
  let response: Response;
  try {
    response = await apiSession().fetch(url, {
      ...init,
      headers: { Accept: "application/json", ...authHeaders(), ...(init.headers as Record<string, string> | undefined) },
      credentials: "omit",
    } as RequestInit);
  } catch (error) {
    throw new ApiError(`Cannot reach ${new URL(url).origin}: ${(error as Error).message}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new ApiError("RomM refused the credentials (HTTP " + response.status + "). Check Settings.", response.status);
  }
  return response;
}

/** JSON request with a timeout, so a stalled server shows an error instead of loading forever. */
export async function apiGet<T = unknown>(path: string, timeoutMs = 30_000): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await apiFetch(path, { signal });
    if (!response.ok) throw new ApiError(`${path} → HTTP ${response.status}`, response.status);
    return (await response.json()) as T;
  } catch (error) {
    if (signal.aborted) throw new ApiError(`RomM did not answer within ${timeoutMs / 1000}s (${path.split("?")[0]}).`);
    throw error;
  }
}
