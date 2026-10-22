import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "stub-backend", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

// a 1x1 transparent PNG, enough to prove binary content survives the proxy.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
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
  ],
}));

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
