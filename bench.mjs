import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONFIG = process.env.HOME + "/.agents/mcp.json";
const CHOSEN = process.env.BENCH_MCP || "github";
const TOOL = process.env.BENCH_TOOL || "get_me";

async function spawnProxy(cfg) {
  const dir = mkdtempSync(join(tmpdir(), "lazy-bench-"));
  const cfgPath = join(dir, "mcp.json");
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js", "--config", cfgPath],
  });
  const client = new Client({ name: "bench", version: "0.0.1" });
  await client.connect(transport);
  return { client, cfgPath };
}

function jsonTokens(sizeChars) {
  return Math.round(sizeChars / 4);
}

async function bench(mode, cfg) {
  const { client } = await spawnProxy(cfg);

  // context = size of the schemas the model holds from listTools.
  const { tools } = await client.listTools();
  const ctxChars = new TextEncoder().encode(JSON.stringify(tools.map(({ inputSchema }) => inputSchema))).length;

  // end-to-end latency for one real tool result using the mode's fastest path.
  const t0 = process.hrtime.bigint();
  if (mode === "lazy") {
    const disc = await client.callTool({
      name: "get_mcp_tools",
      arguments: { mcp: CHOSEN, limit: 10 },
    });
    const parsed = JSON.parse(disc.content[0].text);
    const name = parsed.tools[0].name;
    await client.callTool({
      name: "call_mcp_tool",
      arguments: { mcp: CHOSEN, tool: name, arguments: {} },
    });
  } else {
    await client.callTool({ name: TOOL, arguments: {} });
  }
  const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;

  await client.close();
  return { mode, tools: tools.length, ctxChars, ctxTokens: jsonTokens(ctxChars), latencyMs };
}

const raw = JSON.parse(readFileSync(CONFIG, "utf8"));
const servers = { ...raw.mcpServers };

const cfgLazy = { mcpServers: Object.fromEntries(Object.entries(servers).map(([n, s]) => [n, { ...s, favorite: false }])) };
const cfgFav = {
  mcpServers: Object.fromEntries(
    Object.entries(servers).map(([n, s]) => [n, { ...s, favorite: n === CHOSEN }]),
  ),
};
const cfgAll = { mcpServers: Object.fromEntries(Object.entries(servers).map(([n, s]) => [n, { ...s, favorite: true }])) };

const results = [];
for (const [mode, cfg] of [["lazy", cfgLazy], ["favorites", cfgFav], ["all", cfgAll]]) {
  try {
    results.push(await bench(mode, cfg));
  } catch (err) {
    console.error(`[SKIP] ${mode}: ${err.message}`);
  }
}

const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`);

console.log("\nMCP Lazy Proxy benchmark");
console.log(`chosen backend: ${CHOSEN} (tool: ${TOOL})\n`);
console.log("mode      | injected tools | context (approx tokens) | end-to-end call");
console.log("----------+----------------+-------------------------+----------------");
for (const r of results) {
  console.log(
    `${r.mode.padEnd(9)} | ${String(r.tools).padEnd(14)} | ${String(r.ctxTokens).padEnd(23)} | ${fmt(r.latencyMs)}`,
  );
}

const lazy = results.find((r) => r.mode === "lazy");
const fav = results.find((r) => r.mode === "favorites");
const all = results.find((r) => r.mode === "all");
if (lazy && fav && all) {
  console.log("\ncontext: favorites adds", fav.ctxTokens - lazy.ctxTokens, "tokens vs all-lazy;");
  console.log("         all-eager adds", all.ctxTokens - lazy.ctxTokens, "tokens vs all-lazy.");
  if (fav.latencyMs < lazy.latencyMs) {
    console.log(`latency: favorites first-call ${fmt(lazy.latencyMs - fav.latencyMs)} faster than all-lazy.`);
  }
}
