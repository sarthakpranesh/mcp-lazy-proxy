import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE OK");
