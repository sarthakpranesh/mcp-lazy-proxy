import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWithin, readFileWithin } from "../dist/files.js";

const makeDir = () => mkdtemp(join(tmpdir(), "mlp-files-"));

test("resolveWithin accepts a relative name, an absolute path, and a /files/ URL", async () => {
  const dir = await makeDir();
  await mkdir(join(dir, "out"));
  const file = join(dir, "out", "shot.png");
  await writeFile(file, "x");
  await writeFile(join(dir, "out", "shot one.png"), "y");
  const real = await realpath(file);
  const realSpaced = await realpath(join(dir, "out", "shot one.png"));

  assert.equal(await resolveWithin(dir, "out/shot.png"), real);
  assert.equal(await resolveWithin(dir, file), real);
  assert.equal(await resolveWithin(dir, `/files/out/shot.png`), real);
  assert.equal(await resolveWithin(dir, `http://homelab:3000/files/out/shot.png`), real);
  assert.equal(await resolveWithin(dir, "/files/out/shot%20one.png"), realSpaced);
});

test("resolveWithin rejects escapes", async () => {
  const parent = await makeDir();
  const dir = join(parent, "root");
  await mkdir(dir);
  await writeFile(join(dir, "ok.txt"), "ok");
  const outside = join(parent, "secret.txt");
  await writeFile(outside, "secret");
  await symlink(outside, join(dir, "link.txt"));

  // ".." resolves to a file that exists, so only the containment check stops it
  await assert.rejects(() => resolveWithin(dir, "../secret.txt"), /escapes/);
  await assert.rejects(() => resolveWithin(dir, outside), /escapes/);
  // symlink is inside the dir but points outside it
  await assert.rejects(() => resolveWithin(dir, "link.txt"), /escapes/);
});

test("resolveWithin rejects a missing path and an empty path", async () => {
  const dir = await makeDir();
  await assert.rejects(() => resolveWithin(dir, "nope.png"));
  await assert.rejects(() => resolveWithin(dir, "   "), /path is required/);
});

test("readFileWithin reports size and mime type", async () => {
  const dir = await makeDir();
  await writeFile(join(dir, "a.png"), Buffer.alloc(9));
  const { meta } = await readFileWithin(dir, "a.png", 1024);
  assert.deepEqual(meta, { path: "a.png", name: "a.png", size: 9, mimeType: "image/png" });

  await writeFile(join(dir, "b.bin"), "zz");
  assert.equal((await readFileWithin(dir, "b.bin", 1024)).meta.mimeType, "application/octet-stream");
});

test("readFileWithin returns bytes and refuses oversized files", async () => {
  const dir = await makeDir();
  await writeFile(join(dir, "a.txt"), "hello");

  const { meta, data } = await readFileWithin(dir, "a.txt", 1024);
  assert.equal(meta.mimeType, "text/plain");
  assert.equal(data.toString(), "hello");

  await assert.rejects(() => readFileWithin(dir, "a.txt", 2), /above maxBytes/);
});
