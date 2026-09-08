#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { BackendManager } from "./backend.js";
import packageJson from "../package.json" with { type: "json" };

const CONFIG_ARG = "--config";

// parse the --config <path> CLI argument.
function parseArgs(argv: string[]): { configPath: string } {
  const idx = argv.indexOf(CONFIG_ARG);
  if (idx === -1 || !argv[idx + 1]) {
    throw new Error(`usage: mcp-lazy-proxy ${CONFIG_ARG} <path-to-config.json>`);
  }
  return { configPath: argv[idx + 1] };
}

// load config and build the backend manager.
const { configPath } = parseArgs(process.argv.slice(2));
const config = loadConfig(configPath);
const backends = new BackendManager(config.mcpServers);

// eagerly load the tool schemas of any favorite backends so they are injected
// into context up front (remaining backends stay lazy). also returns a map of
// each eager tool name to its owning backend so direct calls route correctly.
const { tools: favoriteTools, owner: favoriteOwner } = await backends.loadFavorites();

// advertised server instructions: a brief blurb plus the backend catalog.
const instructions = [
  "Lazy MCP proxy. Backend MCP servers are not loaded into context by default; discover them on demand.",
  "Available backends:",
  ...backends
    .list()
    .map((b) => `- ${b.name}: ${b.instruction ?? "no description"}`),
  "Workflow: call get_mcp_tools to load a backend's tool schemas, then call_mcp_tool to invoke one.",
].join("\n");

// create the MCP server with the tools capability flag.
// capabilities.tools is a capability flag (not the tool list); the two
// meta-tools are served by the ListToolsRequestSchema handler below.
const server = new Server(
  { name: packageJson.name, version: packageJson.version },
  { capabilities: { tools: {} }, instructions },
);

// advertise the meta-tools plus any eagerly-loaded favorite backend schemas.
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    ...favoriteTools,
    {
      name: "get_mcp_tools",
      description:
        "Discover the tools exposed by a configured MCP backend. Returns the backend's instruction (if any) plus a filtered list of tool names, descriptions, and input schemas. Call this before call_mcp_tool to learn what a backend can do.",
      inputSchema: {
        type: "object",
        properties: {
          mcp: { type: "string", description: "Name of the MCP backend from the proxy config." },
          query: { type: "string", description: "Optional substring filter on tool name/description." },
          limit: { type: "number", description: "Optional cap on results (default 50)." },
        },
        required: ["mcp"],
      },
    },
    {
      name: "call_mcp_tool",
      description:
        "Invoke a tool on a configured MCP backend. Use the tool name and arguments returned by get_mcp_tools.",
      inputSchema: {
        type: "object",
        properties: {
          mcp: { type: "string", description: "Name of the MCP backend from the proxy config." },
          tool: { type: "string", description: "Tool name as returned by get_mcp_tools." },
          arguments: {
            type: "object",
            description: "Arguments per the tool's input schema.",
            additionalProperties: true,
          },
        },
        required: ["mcp", "tool", "arguments"],
      },
    },
  ],
}));

// handle calls to the two meta-tools, dispatching to the right backend.
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    // get_mcp_tools: load a backend's tool schemas (with optional filter/limit).
    if (name === "get_mcp_tools") {
      const mcp = String(args?.mcp ?? "");
      const query = args?.query ? String(args.query) : undefined;
      const limit = args?.limit != null ? Number(args.limit) : 50;
      const handle = await backends.get(mcp);
      const tools = await handle.listTools(query, limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { mcp, instruction: handle.instruction ?? null, tools },
              null,
              2,
            ),
          },
        ],
      };
    }

    // call_mcp_tool: forward a tool invocation to a backend.
    if (name === "call_mcp_tool") {
      const mcp = String(args?.mcp ?? "");
      const tool = String(args?.tool ?? "");
      const toolArgs = (args?.arguments ?? {}) as Record<string, unknown>;
      const handle = await backends.get(mcp);
      const result = await handle.callTool(tool, toolArgs);
      return {
        content: [
          {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    // direct call to an injected favorite tool: route to its owning backend.
    const ownerObj = favoriteOwner.get(name);
    if (ownerObj) {
      const handle = await backends.get(ownerObj.backend);
      const result = await handle.callTool(ownerObj.realToolName, (args ?? {}) as Record<string, unknown>);
      return {
        content: [
          {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  } catch (err) {
    return {
      content: [{ type: "text", text: `error: ${(err as Error).message}` }],
      isError: true,
    };
  }
});

// connect over stdio and clean up backends on shutdown.
const transport = new StdioServerTransport();
await server.connect(transport);

// clean up backends on shutdown.
process.on("SIGINT", async () => {
  await backends.closeAll();
  process.exit(0);
});

// clean up backends on termination.
process.on("SIGTERM", async () => {
  await backends.closeAll();
  process.exit(0);
});
