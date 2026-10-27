import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve as resolvePath, sep } from "node:path";

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

  // canonical base so symlinks inside the dir (and a symlinked tmpdir on macOS)
  // can't be used to escape it.
  let base: string;
  let real: string;
  try {
    base = await realpath(filesDir);
    const name = decodeURIComponent((req.url ?? "").split("?")[0].slice("/files/".length));
    const file = resolvePath(base, name);
    if (!file.startsWith(base + sep)) return notFound();
    real = await realpath(file); // resolves ".." and follows symlinks
    if (!real.startsWith(base + sep)) return notFound();
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
