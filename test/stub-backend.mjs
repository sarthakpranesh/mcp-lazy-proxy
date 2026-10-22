import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "stub-backend", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

// a 1x1 transparent PNG, enough to prove binary content survives the proxy.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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
  if (req.params.name === "image") {
    return {
      content: [{ type: "image", data: PNG, mimeType: "image/png" }],
      structuredContent: { ok: true },
    };
  }
  if (req.params.name === "fail") {
    return { content: [{ type: "text", text: "boom" }], isError: true };
  }
  return { content: [{ type: "text", text: JSON.stringify(req.params.arguments ?? {}) }] };
});

await server.connect(new StdioServerTransport());
