import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, rmSync } from "node:fs";

const CONFIG = process.env.HOME + "/.agents/mcp.json";

async function connect(config = CONFIG) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js", "--config", config],
  });
  const client = new Client({ name: "smoke", version: "0.0.1" });
  await client.connect(transport);
  return client;
}

// backend names configured in the given config file, in declaration order.
function backendNames(config = CONFIG) {
  const cfg = JSON.parse(readFileSync(config, "utf8"));
  return Object.keys(cfg.mcpServers ?? {});
}

// names of backends that are spawned locally via `command`. these are the only
// ones the smoke suite can reach deterministically — remote (url) backends
// depend on network/credentials the test machine may not have.
function localBackendNames(config = CONFIG) {
  const cfg = JSON.parse(readFileSync(config, "utf8"));
  return (Object.entries(cfg.mcpServers ?? []))
    .filter(([, v]) => v && typeof (v.command ?? v.url) === "string" && v.command)
    .map(([name]) => name);
}

// log a skipped check (a hard assertion that can't run with the current config).
function skipped(label, reason) {
  console.log(`\n[SKIP] ${label}: ${reason}`);
}

async function check(label, fn) {
  try {
    await fn();
    console.log(`\n[PASS] ${label}`);
  } catch (err) {
    console.error(`\n[FAIL] ${label}: ${err.message}`);
    process.exitCode = 1;
  }
}

const client = await connect();

await check("proxy exposes only the 2 meta-tools", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  console.log("  tools:", names.join(", "));
  if (names.length !== 2) throw new Error(`expected 2 tools, got ${names.length}`);
});

const names = localBackendNames();
console.log("  configured backends:", backendNames().join(", ") || "(none)");
console.log("  locally-run backends:", names.join(", ") || "(none)");

await check("server advertises instructions via getInstructions", async () => {
  const instructions = client.getInstructions();
  console.log("  instructions:", instructions.split("\n")[0]);
  if (!instructions || !instructions.includes("Available backends:")) {
    throw new Error("instructions missing or malformed");
  }
});

if (names.length > 0) {
  await check("get_mcp_tools loads schemas for each configured backend", async () => {
    for (const n of names) {
      const r = await client.callTool({
        name: "get_mcp_tools",
        arguments: { mcp: n, limit: 2 },
      });
      const parsed = JSON.parse(r.content[0].text);
      console.log(`  ${n}:`, parsed.tools.map((t) => t.name).join(", "));
      if (!parsed.tools.length) throw new Error(`no tools returned for "${n}"`);
    }
  });
} else {
  skipped("get_mcp_tools loads schemas for each configured backend", "no configured backends");
}

await client.close();

if (names.length > 0) {
  await check("instruction falls back to server's own when config omits it", async () => {
    const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
    const target = names[0];
    // drop the instruction for just one backend; the rest stay intact so the
    // config remains valid, and get_mcp_tools must still return some text.
    const fallback = cfg.mcpServers[target].instruction;
    delete cfg.mcpServers[target].instruction;
    const tmp = "/tmp/proxy-noinst.json";
    writeFileSync(tmp, JSON.stringify(cfg));

    const c2 = await connect(tmp);
    try {
      const r = await c2.callTool({
        name: "get_mcp_tools",
        arguments: { mcp: target, limit: 1 },
      });
      const parsed = JSON.parse(r.content[0].text);
      console.log("  fallback instruction:", (parsed.instruction ?? "").split("\n")[0]);
      if (!parsed.instruction) {
        throw new Error("expected a server-provided fallback instruction");
      }
      if (fallback === parsed.instruction) {
        throw new Error("instruction did not fall back (still the config value)");
      }
    } finally {
      // close the subprocess even when assertions above throw, so smoke exits
      await c2.close();
    }
  });
} else {
  skipped("instruction falls back to server's own when config omits it", "no locally-run backends");
}

await runHttpSmoke();

console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE OK");

// --- HTTP mode smoke test (auth reject + a single get_mcp_tools round-trip) ---
async function runHttpSmoke() {
  const TOKEN = "smoke-test-token";
  const CONFIG_PATH = "/tmp/proxy-http-smoke.json";
  const STUB_REL = "test/stub-backend.mjs";

  // config with a local (stdio) stub backend, relative to the repo root
  const cfg = {
    mcpServers: {
      stub: {
        type: "local",
        command: "node",
        args: [new URL(`./${STUB_REL}`, import.meta.url).pathname],
      },
    },
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));

  const PORT = 3999;
  const child = spawn(
    "node",
    ["dist/index.js", "--transport", "http", "--config", CONFIG_PATH, "--port", String(PORT)],
    { env: { ...process.env, MCP_AUTH_TOKEN: TOKEN } },
  );

  try {
    // wait until the server begins listening
    await waitForHttp(`http://127.0.0.1:${PORT}/mcp`);

    await check("http mode rejects missing/invalid token with 401", async () => {
      const noAuth = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: "POST" });
      if (noAuth.status !== 401) {
        throw new Error(`expected 401, got ${noAuth.status}`);
      }
      const badAuth = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
      });
      if (badAuth.status !== 401) {
        throw new Error(`expected 401 for wrong token, got ${badAuth.status}`);
      }
    });

    await check("http mode get_mcp_tools round-trips against stub backend", async () => {
      const client = new Client({ name: "smoke-http", version: "0.0.1" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${PORT}/mcp`),
        { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } },
      );
      await client.connect(transport);
      const r = await client.callTool({
        name: "get_mcp_tools",
        arguments: { mcp: "stub" },
      });
      const parsed = JSON.parse(r.content[0].text);
      console.log("  stub tools:", parsed.tools.map((t) => t.name).join(", "));
      if (!parsed.tools.some((t) => t.name === "echo")) {
        throw new Error("stub echo tool not found");
      }
      await client.close();
    });

    await check("http mode call_mcp_tool dispatches to stub backend", async () => {
      const client = new Client({ name: "smoke-http", version: "0.0.1" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${PORT}/mcp`),
        { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } },
      );
      await client.connect(transport);
      const payload = { hello: "world", n: 42 };
      const r = await client.callTool({
        name: "call_mcp_tool",
        arguments: { mcp: "stub", tool: "echo", arguments: payload },
      });
      const text = r.content[0].text;
      console.log("  echoed:", text.replace(/\n/g, " "));
      // the outer content array JSON-stringifies the stub's payload, so the
      // inner quotes are escaped (\"hello\":\"world\"). assert on the unquoted
      // key/values to confirm the arguments round-tripped end to end.
      if (!text.includes("hello") || !text.includes("world") || !text.includes("42")) {
        throw new Error("echo did not round-trip the payload");
      }
      await client.close();
    });

    await check("http mode returns 404 for an unknown/stale session id", async () => {
      // a request carrying a session id the proxy has never created must be
      // rejected outright so the client re-initializes, instead of 400-looping
      // against an uninitialized transport after a restart or idle eviction.
      const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": "00000000-0000-0000-0000-000000000000",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_mcp_tools", arguments: { mcp: "stub" } },
        }),
      });
      console.log("  stale-session status:", res.status);
      if (res.status !== 404) {
        throw new Error(`expected 404 for unknown session, got ${res.status}`);
      }
    });
  } finally {
    child.kill("SIGTERM");
    rmSync(CONFIG_PATH, { force: true });
  }
}

// poll a URL until it responds (transport errors are expected until it listens)
function waitForHttp(url, timeoutMs = 10000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        await fetch(url, { method: "POST" });
        return resolve();
      } catch {
        if (Date.now() - start > timeoutMs) {
          return reject(new Error(`timed out waiting for ${url}`));
        }
        setTimeout(poll, 200);
      }
    };
    poll();
  });
}
