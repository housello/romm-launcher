import { contextBridge, ipcRenderer } from "electron";

type Result<T> = { ok: true; value: T } | { ok: false; error: string; code: string };

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as Result<T>;
  if (result.ok) return result.value;
  // A plain object: custom properties on an Error are dropped by the context bridge.
  throw { message: result.error, code: result.code };
}

// Arguments are JSON-copied so reactive/proxy objects never reach structured clone.
const plain = (value: unknown) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

contextBridge.exposeInMainWorld("romm", {
  invoke: (channel: string, ...args: unknown[]) => call(channel, ...args.map(plain)),
  onToolProgress: (listener: (event: unknown) => void) => {
    const wrapped = (_: unknown, event: unknown) => listener(event);
    ipcRenderer.on("tool-progress", wrapped);
    return () => ipcRenderer.removeListener("tool-progress", wrapped);
  },
  onUpdateProgress: (listener: (progress: { received: number; total: number }) => void) => {
    const wrapped = (_: unknown, progress: { received: number; total: number }) => listener(progress);
    ipcRenderer.on("update-progress", wrapped);
    return () => ipcRenderer.removeListener("update-progress", wrapped);
  },
  onConnection: (listener: (online: boolean) => void) => {
    const wrapped = (_: unknown, online: boolean) => listener(online);
    ipcRenderer.on("connection", wrapped);
    return () => ipcRenderer.removeListener("connection", wrapped);
  },
  onLaunchEvent: (listener: (event: unknown) => void) => {
    const wrapped = (_: unknown, event: unknown) => listener(event);
    ipcRenderer.on("launch-event", wrapped);
    return () => ipcRenderer.removeListener("launch-event", wrapped);
  },
});
