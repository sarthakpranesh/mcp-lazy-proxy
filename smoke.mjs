import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// self-contained smoke test: every backend is a local stub spawned from this
// repo, so no user config, credentials, or network access is required.
const DIST = fileURLToPath(new URL("./dist/index.js", import.meta.url));
const STUB = fileURLToPath(new URL("./test/stub-backend.mjs", import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "mcp-proxy-smoke-"));

// per-check budget: a hung backend or proxy must fail the check, not the run.
const CHECK_TIMEOUT_MS = 20_000;

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// run one labelled check under a timeout; failures are collected, not fatal.
async function check(label, fn) {
  let timer;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${CHECK_TIMEOUT_MS}ms`)), CHECK_TIMEOUT_MS);
      }),
    ]);
    passed++;
    console.log(`\n[PASS] ${label}`);
  } catch (err) {
    failed++;
    process.exitCode = 1;
    console.error(`\n[FAIL] ${label}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// write a throwaway proxy config into the temp dir.
function writeConfig(name, servers) {
  const path = join(TMP, `${name}.json`);
  writeFileSync(path, JSON.stringify({ mcpServers: servers }, null, 2));
  return path;
}

// a local backend entry for the stub, using this same node binary.
function stubBackend(extra = {}) {
  return { type: "local", command: process.execPath, args: [STUB], ...extra };
}

// connect a client, run fn, and always close it (even when an assertion throws).
async function withClient(makeTransport, fn) {
  const transport = makeTransport();
  const client = new Client({ name: "smoke", version: "0.0.1" });
  await client.connect(transport);
  try {
    return await fn(client, transport);
  } finally {
    await client.close().catch(() => {});
  }
}

function withStdio(config) {
  return (fn) =>
    withClient(
      () => new StdioClientTransport({ command: process.execPath, args: [DIST, "--config", config] }),
      fn,
    );
}

const page = (r) => JSON.parse(r.content[0].text);
const toolNames = (r) => page(r).tools.map((t) => t.name);

// a hot-reloaded tool is added by the stub when echo receives {bump:true}; the
// proxy only reports it after its cached list is invalidated by the notification.
async function waitForTool(callGetTools, wanted) {
  let names = [];
  for (let i = 0; i < 20 && !names.includes(wanted); i++) {
    await new Promise((r) => setTimeout(r, 100));
    names = toolNames(await callGetTools());
  }
  return names;
}

// spawn a CLI and return {status, stdout, stderr} without leaking processes.
function runCli(args, env) {
  return spawnSync(process.execPath, [DIST, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: env ? { ...process.env, ...env } : process.env,
  });
}

// ---- stdio (local) mode ---------------------------------------------------

const lazyConfig = writeConfig("lazy", {
  stub: stubBackend({ instruction: "Stub backend for smoke tests.", filesEnv: "IMAGE_DIR" }),
  // explicit env must win over the IMAGE_DIR the proxy injects via filesEnv.
  stubAlt: stubBackend({
    filesEnv: "IMAGE_DIR",
    env: { IMAGE_DIR: join(TMP, "alt-images"), STUB_NAME: "alt" },
  }),
});

await check("stdio: exposes only get_mcp_tools and call_mcp_tool", () =>
  withStdio(lazyConfig)(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    console.log("  tools:", names.join(", "));
    assert(names.length === 2, `expected 2 tools, got ${names.length}`);
    assert(names.join() === "get_mcp_tools,call_mcp_tool", `unexpected tools: ${names}`);
    const call = tools.find((t) => t.name === "call_mcp_tool");
    assert(call.inputSchema.required.join() === "mcp,toolName,arguments", "call_mcp_tool schema drifted");
    const get = tools.find((t) => t.name === "get_mcp_tools");
    assert(get.inputSchema.required.join() === "mcp", "get_mcp_tools schema drifted");
  }),
);

await check("stdio: advertises the backend catalog in instructions", () =>
  withStdio(lazyConfig)(async (client) => {
    const instructions = client.getInstructions();
    console.log("  instructions:", (instructions ?? "").split("\n")[0]);
    assert(instructions && instructions.includes("Available backends:"), "instructions missing catalog header");
    assert(instructions.includes("stub"), "instructions missing backend name");
  }),
);

await check("stdio: get_mcp_tools returns all tools with metadata intact", () =>
  withStdio(lazyConfig)(async (client) => {
    const p = page(await client.callTool({ name: "get_mcp_tools", arguments: { mcp: "stub" } }));
    console.log("  stub tools:", p.tools.map((t) => t.name).join(", "));
    assert(p.mcp === "stub", `mcp echoed wrong: ${p.mcp}`);
    assert(p.instruction === "Stub backend for smoke tests.", `instruction wrong: ${p.instruction}`);
    assert(p.tools.length === 5, `expected 5 tools, got ${p.tools.length}`);
    const image = p.tools.find((t) => t.name === "image");
    assert(image?.outputSchema, "outputSchema dropped");
    assert(image.title === "Image", "title dropped");
    assert(image.annotations?.readOnlyHint, "annotations dropped");
  }),
);

await check("stdio: get_mcp_tools filters by query and caps by limit", () =>
  withStdio(lazyConfig)(async (client) => {
    const filtered = toolNames(
      await client.callTool({ name: "get_mcp_tools", arguments: { mcp: "stub", query: "imag" } }),
    );
    console.log("  query=imag:", filtered.join(", "));
    assert(filtered.join() === "image", `query filter wrong: ${filtered}`);
    const capped = toolNames(
      await client.callTool({ name: "get_mcp_tools", arguments: { mcp: "stub", limit: 2 } }),
    );
    assert(capped.length === 2, `limit ignored: ${capped.length}`);
    const none = toolNames(
      await client.callTool({ name: "get_mcp_tools", arguments: { mcp: "stub", query: "zzz" } }),
    );
    assert(none.length === 0, `expected no matches, got ${none}`);
  }),
);

await check("stdio: get_mcp_tools merges backend pages before applying limit", () =>
  withStdio(lazyConfig)(async (client) => {
    // the stub serves 5 tools over 3 pages of 2; a limit above the page size must
    // still return all 5, proving the proxy walked the cursor.
    const all = toolNames(await client.callTool({ name: "get_mcp_tools", arguments: { mcp: "stub", limit: 10 } }));
    console.log("  merged tools:", all.length);
    assert(all.length === 5, `expected 5 tools, got ${all.length}`);
  }),
);

await check("stdio: get_mcp_tools rejects an unknown backend", () =>
  withStdio(lazyConfig)(async (client) => {
    const r = await client.callTool({ name: "get_mcp_tools", arguments: { mcp: "nope" } });
    console.log("  error:", r.content[0].text);
    assert(r.isError === true, "unknown backend did not set isError");
    assert(r.content[0].text.includes('unknown mcp server "nope"'), "wrong error text");
  }),
);

await check("stdio: call_mcp_tool round-trips arguments", () =>
  withStdio(lazyConfig)(async (client) => {
    const r = await client.callTool({
      name: "call_mcp_tool",
      arguments: { mcp: "stub", toolName: "echo", arguments: { hello: "world", n: 42 } },
    });
    console.log("  echoed:", r.content[0].text.replace(/\n/g, " "));
    assert(r.content[0].text.includes("hello") && r.content[0].text.includes("42"), "payload not round-tripped");
  }),
);

await check("stdio: call_mcp_tool defaults missing arguments to an empty object", () =>
  withStdio(lazyConfig)(async (client) => {
    const r = await client.callTool({ name: "call_mcp_tool", arguments: { mcp: "stub", toolName: "echo" } });
    assert(r.content[0].text === "{}", `expected {}, got ${r.content[0].text}`);
  }),
);

await check("stdio: call_mcp_tool preserves image blocks, structuredContent, and isError", () =>
  withStdio(lazyConfig)(async (client) => {
    const img = await client.callTool({ name: "call_mcp_tool", arguments: { mcp: "stub", toolName: "image", arguments: {} } });
    console.log("  image block type:", img.content[0].type);
    assert(img.content[0].type === "image" && img.content[0].mimeType === "image/png", "image block dropped");
    assert(img.structuredContent?.ok === true, "structuredContent dropped");

    const failedRes = await client.callTool({ name: "call_mcp_tool", arguments: { mcp: "stub", toolName: "fail", arguments: {} } });
    console.log("  failed result isError:", failedRes.isError);
    assert(failedRes.isError === true, "isError dropped");
    assert(failedRes.content[0].text === "boom", "error text not passed through");
  }),
);

await check("stdio: call_mcp_tool rejects unknown backend and unknown tool", () =>
  withStdio(lazyConfig)(async (client) => {
    const noMcp = await client.callTool({ name: "call_mcp_tool", arguments: { mcp: "nope", toolName: "x", arguments: {} } });
    assert(noMcp.isError === true && noMcp.content[0].text.includes("unknown mcp server"), noMcp.content[0].text);
    const noTool = await client.callTool({ name: "call_mcp_tool", arguments: { mcp: "stub", toolName: "nope", arguments: {} } });
    console.log("  unknown tool:", noTool.content[0].text);
    assert(noTool.isError === true && noTool.content[0].text.includes("no such tool"), "backend error not surfaced");
  }),
);

await check("stdio: cached tool list is invalidated by tools/list_changed", () =>
  withStdio(lazyConfig)(async (client) => {
    await client.callTool({ name: "call_mcp_tool", arguments: { mcp: "stub", toolName: "echo", arguments: { bump: true } } });
    const names = await waitForTool(() => client.callTool({ name: "get_mcp_tools", arguments: { mcp: "stub" } }), "extra");
    console.log("  refreshed tools:", names.join(", "));
    assert(names.includes("extra"), `list not refreshed: ${names}`);
  }),
);

const fallbackConfig = writeConfig("fallback", { stub: stubBackend() });
await check("stdio: instruction falls back to the backend's own when config omits it", () =>
  withStdio(fallbackConfig)(async (client) => {
    const p = page(await client.callTool({ name: "get_mcp_tools", arguments: { mcp: "stub", limit: 1 } }));
    console.log("  fallback instruction:", p.instruction);
    assert(p.instruction === "stub backend instructions", `unexpected fallback: ${p.instruction}`);
  }),
);

// ---- favorites ------------------------------------------------------------

const favoritesConfig = writeConfig("favorites", {
  fav: stubBackend({ instruction: "Favorite stub", favorite: true }),
  lazy: stubBackend({ instruction: "Lazy stub" }),
});

await check("favorites: eager schemas are injected with a backend__tool prefix", () =>
  withStdio(favoritesConfig)(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    console.log("  tools:", names.join(", "));
    assert(names.includes("get_mcp_tools") && names.includes("call_mcp_tool"), "meta-tools missing");
    assert(names.includes("fav__echo"), `favorite tool not injected: ${names}`);
    assert(!names.some((n) => n.startsWith("lazy__")), "lazy backend should not be injected");
    assert(tools.length === 7, `expected 7 tools, got ${tools.length}`);
  }),
);

await check("favorites: direct calls route to the owning backend only", () =>
  withStdio(favoritesConfig)(async (client) => {
    const ok = await client.callTool({ name: "fav__echo", arguments: { x: 1 } });
    console.log("  direct call:", ok.content[0].text);
    assert(ok.content[0].text.includes('"x":1'), "favorite call not routed");
    const rejected = await client.callTool({ name: "lazy__echo", arguments: {} });
    assert(rejected.isError === true && rejected.content[0].text.includes("unknown tool"), "lazy tool was routable");
    const viaMeta = toolNames(await client.callTool({ name: "get_mcp_tools", arguments: { mcp: "lazy", limit: 1 } }));
    assert(viaMeta.length === 1, "lazy backend unreachable via get_mcp_tools");
  }),
);

await check("favorites: a tools/list_changed from a favorite rebuilds its schemas", () =>
  withStdio(favoritesConfig)(async (client) => {
    await client.callTool({ name: "fav__echo", arguments: { bump: true } });
    let names = [];
    for (let i = 0; i < 20 && !names.includes("fav__extra"); i++) {
      await new Promise((r) => setTimeout(r, 100));
      names = (await client.listTools()).tools.map((t) => t.name);
    }
    console.log("  injected tools:", names.join(", "));
    assert(names.includes("fav__extra"), `favorite schemas not refreshed: ${names}`);
  }),
);

// ---- config + CLI validation (no server should start) ---------------------

await check("config: ${VAR} references are substituted from the environment", () => {
  const config = writeConfig("env", { stub: stubBackend({ command: "${SMOKE_STUB_CMD}" }) });
  // spawn the proxy through the client with the var set: discovery must succeed.
  return withClient(
    () =>
      new StdioClientTransport({
        command: process.execPath,
        args: [DIST, "--config", config],
        env: { ...process.env, SMOKE_STUB_CMD: process.execPath },
      }),
    async (client) => {
      const p = page(await client.callTool({ name: "get_mcp_tools", arguments: { mcp: "stub", limit: 1 } }));
      assert(p.tools.length === 1, "env-substituted backend failed to start");
    },
  );
});

await check("config: a missing env var fails fast with a clear error", () => {
  const config = writeConfig("bad-env", { stub: stubBackend({ command: "${SMOKE_NOT_SET}" }) });
  const r = runCli(["--config", config]);
  console.log("  stderr:", r.stderr.trim().split("\n")[0]);
  assert(r.status !== 0, `expected non-zero exit, got ${r.status}`);
  assert(r.stderr.includes("SMOKE_NOT_SET"), "missing env var not named in the error");
});

await check("config: a backend without url/command is rejected", () => {
  const config = writeConfig("bad-backend", { broken: {} });
  const r = runCli(["--config", config]);
  assert(r.status !== 0 && r.stderr.includes('must have a "url" or "command"'), `stderr: ${r.stderr}`);
});

await check("config: a config without mcpServers is rejected", () => {
  const path = join(TMP, "bad-shape.json");
  writeFileSync(path, JSON.stringify({ nope: true }));
  const r = runCli(["--config", path]);
  assert(r.status !== 0 && r.stderr.includes('must have an "mcpServers" object'), `stderr: ${r.stderr}`);
});

await check("cli: an unsupported --transport is rejected", () => {
  const r = runCli(["--transport", "grpc", "--config", lazyConfig]);
  assert(r.status !== 0 && r.stderr.includes('unsupported --transport "grpc"'), `stderr: ${r.stderr}`);
});

await check("cli: http mode refuses to start without MCP_AUTH_TOKEN", () => {
  const { MCP_AUTH_TOKEN, ...env } = process.env;
  const r = runCli(["--transport", "http", "--config", lazyConfig], env);
  assert(r.status !== 0 && r.stderr.includes("MCP_AUTH_TOKEN must be set"), `stderr: ${r.stderr}`);
});

// ---- HTTP (shared) mode ---------------------------------------------------

const TOKEN = "smoke-test-token";
// same 1x1 png the stub writes into IMAGE_DIR.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
let proxy;
try {
  proxy = await startHttpProxy(lazyConfig, TOKEN);
  const origin = `http://127.0.0.1:${proxy.port}`;
  const base = `${origin}/mcp`;
  const auth = { Authorization: `Bearer ${TOKEN}` };

  const withHttp = (fn, token = TOKEN) =>
    withClient(
      () =>
        new StreamableHTTPClientTransport(new URL(base), {
          requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
        }),
      fn,
    );

  await check("http: health probe is reachable without a token", async () => {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/health`);
    console.log("  /health:", res.status);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert((await res.json()).ok === true, "health body malformed");
  });

  await check("http: missing, wrong, and malformed tokens all get 401", async () => {
    const post = (headers) => fetch(base, { method: "POST", headers });
    const noAuth = await post({});
    const wrong = await post({ Authorization: "Bearer wrong" });
    const malformed = await post({ Authorization: "Bearer" });
    console.log("  statuses:", noAuth.status, wrong.status, malformed.status);
    assert(noAuth.status === 401, `no auth: ${noAuth.status}`);
    assert(wrong.status === 401, `wrong token: ${wrong.status}`);
    assert(malformed.status === 401, `malformed header: ${malformed.status}`);
  });

  await check("http: unknown paths return 404", async () => {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/nope`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    console.log("  status:", res.status);
    assert(res.status === 404, `expected 404, got ${res.status}`);
  });

  await check("http: backend files are downloadable with the auth token", () =>
    withHttp(async (client) => {
      // this spawns the stub, which writes its boot file into IMAGE_DIR.
      await client.callTool({ name: "get_mcp_tools", arguments: { mcp: "stub" } });
      const res = await fetch(`${origin}/files/stub-boot.png`, { headers: auth });
      const body = Buffer.from(await res.arrayBuffer());
      console.log("  /files:", res.status, res.headers.get("content-type"), body.length, "bytes");
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(body.equals(Buffer.from(PNG, "base64")), "served bytes differ from backend output");
      assert(res.headers.get("x-content-type-options") === "nosniff", "missing nosniff header");
      assert(/^attachment/.test(res.headers.get("content-disposition") ?? ""), "missing attachment disposition");
    }));

  await check("http: /files requires a token", async () => {
    const res = await fetch(`${origin}/files/stub-boot.png`);
    console.log("  status:", res.status);
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await check("http: /files rejects traversal and escaping symlinks", async () => {
    // ten ".." segments reach /etc/hostname from the files dir on any layout.
    const escape = "%2e%2e%2f".repeat(10) + "etc%2fhostname";
    const paths = [`/files/${escape}`, "/files/stub-escape", "/files/nope.png"];
    for (const path of paths) {
      const res = await fetch(`${origin}${path}`, { headers: auth });
      console.log("  ", path.slice(0, 48), res.status);
      assert(res.status === 404, `${path}: expected 404, got ${res.status}`);
    }
  });

  await check("http: an explicit IMAGE_DIR wins over the proxy files dir", () =>
    withHttp(async (client) => {
      // this spawns stubAlt, which honours its own env.IMAGE_DIR over filesEnv.
      await client.callTool({ name: "get_mcp_tools", arguments: { mcp: "stubAlt" } });
      assert(
        existsSync(join(TMP, "alt-images", "alt-boot.png")),
        "backend did not write to its explicit IMAGE_DIR",
      );
      const res = await fetch(`${origin}/files/alt-boot.png`, { headers: auth });
      console.log("  /files/alt-boot.png:", res.status);
      assert(res.status === 404, `expected 404, got ${res.status}`);
    }));

  await check("http: GET /mcp without a session id returns 404", async () => {
    const res = await fetch(base, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "text/event-stream" },
    });
    console.log("  status:", res.status);
    assert(res.status === 404, `expected 404, got ${res.status}`);
  });

  await check("http: get_mcp_tools round-trips against the stub backend", () =>
    withHttp(async (client) => {
      const p = page(await client.callTool({ name: "get_mcp_tools", arguments: { mcp: "stub" } }));
      console.log("  stub tools:", p.tools.map((t) => t.name).join(", "));
      assert(p.tools.length === 5, `expected 5 tools, got ${p.tools.length}`);
    }));

  await check("http: pagination is merged before limit is applied", () =>
    withHttp(async (client) => {
      const all = toolNames(await client.callTool({ name: "get_mcp_tools", arguments: { mcp: "stub", limit: 10 } }));
      const capped = toolNames(await client.callTool({ name: "get_mcp_tools", arguments: { mcp: "stub", limit: 2 } }));
      console.log("  merged:", all.length, "capped:", capped.length);
      assert(all.length === 5, `expected 5 tools, got ${all.length}`);
      assert(capped.length === 2, `expected 2 tools, got ${capped.length}`);
    }));

  await check("http: get_mcp_tools filters by query", () =>
    withHttp(async (client) => {
      const names = toolNames(await client.callTool({ name: "get_mcp_tools", arguments: { mcp: "stub", query: "imag" } }));
      assert(names.join() === "image", `query filter wrong: ${names}`);
    }));

  await check("http: call_mcp_tool dispatches to the stub backend", () =>
    withHttp(async (client) => {
      const r = await client.callTool({
        name: "call_mcp_tool",
        arguments: { mcp: "stub", toolName: "echo", arguments: { hello: "world", n: 42 } },
      });
      console.log("  echoed:", r.content[0].text.replace(/\n/g, " "));
      assert(r.content[0].text.includes("hello") && r.content[0].text.includes("42"), "payload not round-tripped");
    }));

  await check("http: call_mcp_tool preserves image blocks and isError end-to-end", () =>
    withHttp(async (client) => {
      const img = await client.callTool({ name: "call_mcp_tool", arguments: { mcp: "stub", toolName: "image", arguments: {} } });
      console.log("  image block type:", img.content[0].type);
      assert(img.content[0].type === "image" && img.content[0].mimeType === "image/png", "image block dropped");
      assert(img.structuredContent?.ok === true, "structuredContent dropped");

      const failedRes = await client.callTool({ name: "call_mcp_tool", arguments: { mcp: "stub", toolName: "fail", arguments: {} } });
      console.log("  failed result isError:", failedRes.isError);
      assert(failedRes.isError === true, "isError dropped");
      assert(failedRes.content[0].text === "boom", "error text not passed through");
    }));

  await check("http: discovery preserves outputSchema, title, and annotations", () =>
    withHttp(async (client) => {
      const { tools } = page(await client.callTool({ name: "get_mcp_tools", arguments: { mcp: "stub" } }));
      const image = tools.find((t) => t.name === "image");
      assert(image?.outputSchema, "outputSchema dropped");
      assert(image.title === "Image", "title dropped");
      assert(image.annotations?.readOnlyHint, "annotations dropped");
    }));

  await check("http: an unknown session id is rejected with 404", async () => {
    const res = await fetch(base, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": "00000000-0000-0000-0000-000000000000",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_mcp_tools", arguments: { mcp: "stub" } } }),
    });
    console.log("  stale-session status:", res.status);
    assert(res.status === 404, `expected 404 for unknown session, got ${res.status}`);
  });

  await check("http: terminating a session unregisters it", async () => {
    let sid;
    await withHttp(async (_client, transport) => {
      sid = transport.sessionId;
      // the SDK does not send DELETE on close(); terminateSession() does.
      await transport.terminateSession();
    });
    assert(sid, "client connected without a session id");
    const res = await fetch(base, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sid,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    console.log("  closed-session status:", res.status);
    assert(res.status === 404, `expected 404 after close, got ${res.status}`);
  });

  await check("http: SIGTERM shuts the proxy down cleanly", async () => {
    const code = await stopChild(proxy.child);
    console.log("  exit code:", code);
    assert(code === 0, `expected exit 0, got ${code}`);
    console.log("  stderr:", proxy.stderr.trim() || "(empty)");
    assert(!/transport error/i.test(proxy.stderr), "transport error logged during shutdown");
    proxy = undefined;
  });
} finally {
  // always tear the child down, even if startup or an assertion failed.
  if (proxy) await stopChild(proxy.child);
  rmSync(TMP, { recursive: true, force: true });
}

console.log(failed ? `\nSMOKE FAILED (${failed} failed, ${passed} passed)` : `\nSMOKE OK (${passed} passed)`);

// --- helpers ---------------------------------------------------------------

// spawn the proxy in HTTP mode on an OS-assigned port and read the actual port
// from its startup summary, so parallel runs can never collide.
async function startHttpProxy(configPath, token) {
  const child = spawn(process.execPath, [DIST, "--transport", "http", "--config", configPath, "--port", "0"], {
    env: { ...process.env, MCP_AUTH_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`proxy did not report a port in 10s\nstdout: ${stdout}\nstderr: ${stderr}`)), 10_000);
    const onData = () => {
      const m = /"port":\s*(\d+)/.exec(stdout);
      if (!m) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      resolve(Number(m[1]));
    };
    child.stdout.on("data", onData);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`proxy exited (code=${code} signal=${signal}) before listening\nstderr: ${stderr}`));
    });
  });

  return { child, port, get stderr() { return stderr; } };
}

// SIGTERM, then SIGKILL if the process does not exit in time.
function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(child.exitCode ?? child.signalCode);
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve(code ?? signal);
    });
    child.kill("SIGTERM");
  });
}
