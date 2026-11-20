// A small WebDAV client (Nextcloud, ownCloud, any RFC 4918 server): list a folder
// tree, download, upload (creating folders as needed). Requests go through
// Electron's network stack, so system proxies and certificates apply.

import { net } from "electron";

export interface DavFile {
  /** Path relative to the listed folder, "/"-separated. */
  rel: string;
  size: number;
  /** Changes whenever the file's content does. */
  etag: string;
  mtime: number;
}

export class DavError extends Error {
  constructor(message: string, public status = 0) {
    super(message);
  }
}

const PROPFIND_BODY = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getetag/><d:getlastmodified/></d:prop></d:propfind>`;

/** Text of the first <prefix:name> element in `xml`, whatever the namespace prefix. */
function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "i").exec(xml);
  return m ? m[1]!.trim() : null;
}

export class WebDav {
  private readonly root: URL;
  private readonly auth: string;
  private readonly made = new Set<string>();

  constructor(url: string, username: string, password: string) {
    if (!/^https?:\/\//i.test(url)) throw new DavError("The WebDAV address must start with http:// or https://");
    this.root = new URL(url.endsWith("/") ? url : url + "/");
    this.auth = "Basic " + Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  }

  /** URL of a "/"-separated path under the root, each segment encoded. */
  private url(path: string, folder = false): string {
    const encoded = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    return new URL(encoded + (folder && encoded ? "/" : ""), this.root).toString();
  }

  private async request(method: string, url: string, init: { headers?: Record<string, string>; body?: BodyInit } = {}): Promise<Response> {
    let response: Response;
    try {
      response = await net.fetch(url, {
        method,
        headers: { Authorization: this.auth, ...init.headers },
        body: init.body,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new DavError(`Cannot reach ${this.root.host}: ${(error as Error).message}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new DavError(`The WebDAV server refused the login (HTTP ${response.status}).`, response.status);
    }
    return response;
  }

  /** Every file under `path`, recursively; an absent folder has none. */
  async walk(path: string): Promise<Map<string, DavFile>> {
    const files = new Map<string, DavFile>();
    const base = new URL(this.url(path, true)).pathname;
    const pending = [path];
    while (pending.length) {
      const dir = pending.shift()!;
      const response = await this.request("PROPFIND", this.url(dir, true), {
        headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
        body: PROPFIND_BODY,
      });
      if (response.status === 404) continue;
      if (response.status !== 207) throw new DavError(`Listing ${dir || "/"} failed: HTTP ${response.status}`, response.status);
      const xml = await response.text();
      const self = new URL(this.url(dir, true)).pathname;
      for (const block of xml.match(/<(?:[\w-]+:)?response\b[\s\S]*?<\/(?:[\w-]+:)?response>/gi) ?? []) {
        const href = tag(block, "href");
        if (!href) continue;
        const pathname = new URL(href, this.root).pathname;
        const decoded = decodeURIComponent(pathname);
        if (pathname.replace(/\/$/, "") === self.replace(/\/$/, "")) continue;
        const rel = decodeURIComponent(pathname).slice(decodeURIComponent(base).length).replace(/\/$/, "");
        if (/<(?:[\w-]+:)?collection\b/i.test(tag(block, "resourcetype") ?? "")) {
          pending.push(`${path}/${rel}`);
          continue;
        }
        if (!decoded.startsWith(decodeURIComponent(base))) continue;
        files.set(rel, {
          rel,
          size: Number(tag(block, "getcontentlength") ?? 0),
          etag: (tag(block, "getetag") ?? "").replace(/&quot;/g, '"'),
          mtime: Date.parse(tag(block, "getlastmodified") ?? "") || 0,
        });
      }
    }
    return files;
  }

  async get(path: string): Promise<Buffer> {
    const response = await this.request("GET", this.url(path));
    if (!response.ok) throw new DavError(`Download of ${path} failed: HTTP ${response.status}`, response.status);
    return Buffer.from(await response.arrayBuffer());
  }

  /** Upload a file, creating its folders first. */
  async put(path: string, data: Buffer): Promise<void> {
    const parts = path.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (this.made.has(dir)) continue;
      const response = await this.request("MKCOL", this.url(dir, true));
      // 405: the folder already exists.
      if (!response.ok && response.status !== 405) throw new DavError(`Creating folder ${dir} failed: HTTP ${response.status}`, response.status);
      this.made.add(dir);
    }
    const response = await this.request("PUT", this.url(path), {
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(data),
    });
    if (!response.ok) throw new DavError(`Upload of ${path} failed: HTTP ${response.status}`, response.status);
  }

  /** Checks the address and login, answering what the server reported. */
  async check(path: string): Promise<void> {
    const response = await this.request("PROPFIND", this.url(path, true), {
      headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
      body: PROPFIND_BODY,
    });
    if (response.status === 404) return; // created on the first upload
    if (response.status !== 207) throw new DavError(`The server answered HTTP ${response.status}; is this a WebDAV address?`, response.status);
  }
}
