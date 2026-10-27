import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, resolve as resolvePath, sep } from "node:path";

// metadata the meta-tool returns alongside (or instead of) the file bytes.
export interface FileMeta {
  /** name relative to the files dir, as it would be fetched from /files/<path>. */
  path: string;
  name: string;
  size: number;
  mimeType: string;
}

// small extension map: enough to type screenshots and exports. unknown types fall
// back to octet-stream, which is what /files/* serves anyway.
const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".html": "text/html",
  ".zip": "application/zip",
};

export function mimeTypeFor(name: string): string {
  return MIME_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
}

// accept whatever handle a caller has: the absolute path a backend printed, a
// plain name relative to the files dir, or a /files/... URL, and reduce it to a
// relative name. callers pass the output of tools verbatim, so this has to be
// forgiving about the prefix but strict about the result (see resolveWithin).
function normalizeFileName(raw: string): string {
  let name = String(raw ?? "").trim();
  if (!name) throw new Error("path is required");
  if (/^(https?|file):\/\//i.test(name)) {
    try {
      name = new URL(name).pathname;
    } catch {
      throw new Error(`not a valid file URL: ${raw}`);
    }
  }
  // strip a /files/ prefix anywhere in the string (proxy URL or bare route).
  const route = name.indexOf("/files/");
  if (route !== -1) name = name.slice(route + "/files/".length);
  try {
    name = decodeURIComponent(name);
  } catch {
    throw new Error(`not a valid file path: ${raw}`);
  }
  return name;
}

// canonical files dir. a symlinked tmpdir (macOS /tmp) must resolve before the
// prefix checks below, otherwise every comparison is against the wrong root.
async function filesRoot(filesDir: string): Promise<string> {
  return realpath(filesDir);
}

// resolve a requested name inside the files dir, or throw. every escape route is
// covered here: "..", absolute paths, and symlinks pointing outside the dir.
export async function resolveWithin(filesDir: string, raw: string): Promise<string> {
  const base = await filesRoot(filesDir);
  const name = normalizeFileName(raw);
  const candidate = resolvePath(base, name);
  let real: string;
  try {
    // realpath canonicalises symlinks, including a symlinked tmpdir in the path a
    // backend printed (macOS /tmp -> /private/tmp), so it must run before the
    // containment check rather than after it.
    real = await realpath(candidate);
  } catch {
    throw new Error(`file not found: ${raw}`);
  }
  if (!real.startsWith(base + sep)) {
    throw new Error(`path escapes the files directory: ${raw}`);
  }
  return real;
}

function metaFor(base: string, real: string, size: number): FileMeta {
  return {
    path: real.slice(base.length + 1),
    name: basename(real),
    size,
    mimeType: mimeTypeFor(real),
  };
}

// read a file's bytes, refusing anything above maxBytes instead of truncating.
export async function readFileWithin(
  filesDir: string,
  raw: string,
  maxBytes: number,
): Promise<{ meta: FileMeta; data: Buffer }> {
  const real = await resolveWithin(filesDir, raw);
  // open without following a symlink swapped in after the realpath check, then
  // read from the handle so the checked path can't change under us.
  const handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`not a file: ${raw}`);
    if (info.size > maxBytes) {
      throw new Error(
        `file is ${info.size} bytes, above maxBytes=${maxBytes}; raise maxBytes to read it`,
      );
    }
    return { meta: metaFor(await filesRoot(filesDir), real, info.size), data: await handle.readFile() };
  } finally {
    await handle.close().catch(() => {});
  }
}

// serve one file from the files dir; auth is already enforced by the caller.
export async function serveFile(
  filesDir: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const notFound = () => {
    // a failure that happens after the 200 has started cannot turn into a 404.
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  };

  let real: string;
  try {
    real = await resolveWithin(filesDir, (req.url ?? "").split("?")[0].slice("/files/".length));
  } catch {
    return notFound();
  }

  let handle: FileHandle | undefined;
  try {
    // open the canonical path without following a symlink swapped in after the
    // realpath check, then stream from the handle so the checked path can't
    // change between validation and read.
    handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      // callers save to disk, so the type adds nothing; also keeps backend
      // written svg/html from ever rendering inline from this origin.
      "Content-Type": "application/octet-stream",
      "Content-Length": info.size,
      "Content-Disposition": "attachment",
      // don't let legacy sniffing turn an export into something renderable.
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    });
    // an error after the 200 must not crash the proxy
    handle
      .createReadStream({ autoClose: true })
      .on("error", () => res.destroy())
      .pipe(res);
    handle = undefined; // the stream owns (and closes) the fd now
  } catch {
    if (handle) await handle.close().catch(() => {});
    notFound();
  }
}
