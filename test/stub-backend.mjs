import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const server = new Server(
  { name: "stub-backend", version: "0.0.1" },
  { capabilities: { tools: {} }, instructions: "stub backend instructions" },
);

// a 1x1 transparent PNG, enough to prove binary content survives the proxy.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// when the proxy (or an explicit env) points IMAGE_DIR at a writable dir, drop
// a file there at startup so smoke tests can prove /files serves backend output.
const IMAGE_DIR = process.env.IMAGE_DIR;
const STUB_NAME = process.env.STUB_NAME ?? "stub";
if (IMAGE_DIR) {
  mkdirSync(IMAGE_DIR, { recursive: true });
  writeFileSync(join(IMAGE_DIR, `${STUB_NAME}-boot.png`), Buffer.from(PNG, "base64"));
  // a symlink planted in the dir must not become a way to read outside it.
  try {
    symlinkSync(process.execPath, join(IMAGE_DIR, `${STUB_NAME}-escape`));
  } catch {
    // symlinks can be unavailable; the traversal check still covers the gate.
  }
}

// tool catalog, served in pages of 2 to exercise the proxy's cursor loop.
const TOOLS = [
  { name: "echo", description: "echo a payload", inputSchema: { type: "object" } },
  {
    name: "image",
    title: "Image",
    description: "return an image block",
    inputSchema: { type: "object" },
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
    annotations: { readOnlyHint: true },
  },
  { name: "fail", description: "return an error result", inputSchema: { type: "object" } },
  { name: "pad1", description: "filler", inputSchema: { type: "object" } },
  { name: "pad2", description: "filler", inputSchema: { type: "object" } },
];
const PAGE = 2;

server.setRequestHandler(ListToolsRequestSchema, async (req) => {
  const start = Number(req.params?.cursor ?? 0);
  const end = start + PAGE;
  return {
    tools: TOOLS.slice(start, end),
    ...(end < TOOLS.length ? { nextCursor: String(end) } : {}),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (!TOOLS.some((t) => t.name === req.params.name)) {
    return { content: [{ type: "text", text: `no such tool: ${req.params.name}` }], isError: true };
  }
  if (req.params.name === "image") {
    return {
      content: [{ type: "image", data: PNG, mimeType: "image/png" }],
      structuredContent: { ok: true },
    };
  }
  if (req.params.name === "fail") {
    return { content: [{ type: "text", text: "boom" }], isError: true };
  }
  if (req.params.arguments?.bump && !TOOLS.some((t) => t.name === "extra")) {
    // simulate a backend that hot-reloads its tool list
    TOOLS.push({ name: "extra", description: "added at runtime", inputSchema: { type: "object" } });
    server.sendToolListChanged();
  }
  return { content: [{ type: "text", text: JSON.stringify(req.params.arguments ?? {}) }] };
});

await server.connect(new StdioServerTransport());
