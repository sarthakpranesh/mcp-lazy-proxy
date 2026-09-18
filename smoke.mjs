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

await check("server advertises instructions via getInstructions", async () => {
  const instructions = client.getInstructions();
  console.log("  instructions:", instructions.split("\n")[0]);
  if (!instructions || !instructions.includes("Available backends:")) {
    throw new Error("instructions missing or malformed");
  }
});

await check("get_mcp_tools loads github schemas", async () => {
  const r = await client.callTool({
    name: "get_mcp_tools",
    arguments: { mcp: "github", limit: 2 },
  });
  const parsed = JSON.parse(r.content[0].text);
  console.log("  instruction:", parsed.instruction);
  console.log("  tools:", parsed.tools.map((t) => t.name).join(", "));
  if (!parsed.tools.length) throw new Error("no tools returned");
});

await check("get_mcp_tools loads n8n personal schemas", async () => {
  const r = await client.callTool({
    name: "get_mcp_tools",
    arguments: { mcp: "n8n personal", limit: 2 },
  });
  const parsed = JSON.parse(r.content[0].text);
  console.log("  tools:", parsed.tools.map((t) => t.name).join(", "));
  if (!parsed.tools.length) throw new Error("no tools returned");
});

await check("call_mcp_tool dispatches to github", async () => {
  const r = await client.callTool({
    name: "call_mcp_tool",
    arguments: { mcp: "github", tool: "get_me", arguments: {} },
  });
  const text = r.content[0].text;
  console.log("  result:", text.slice(0, 80).replace(/\n/g, " "));
  if (!text.includes("sarthakpranesh")) throw new Error("unexpected result");
});

await client.close();

await check("instruction falls back to server's own when config omits it", async () => {
  const { writeFileSync } = await import("node:fs");
  const { readFileSync } = await import("node:fs");
  const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
  delete cfg.mcpServers.github.instruction;
  const tmp = "/tmp/proxy-noinst.json";
  writeFileSync(tmp, JSON.stringify(cfg));

  const c2 = await connect(tmp);
  const r = await c2.callTool({
    name: "get_mcp_tools",
    arguments: { mcp: "github", limit: 1 },
  });
  const parsed = JSON.parse(r.content[0].text);
  console.log("  fallback instruction:", parsed.instruction.split("\n")[0]);
  if (!parsed.instruction || parsed.instruction.includes("GitHub: issues")) {
    throw new Error("expected server-provided fallback instruction");
  }
  await c2.close();
});

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
