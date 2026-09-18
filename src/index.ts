#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { homedir } from "node:os";
import { loadConfig } from "./config.js";
import { BackendManager } from "./backend.js";
import { startHttpServer } from "./server.js";
import packageJson from "../package.json" with { type: "json" };

const CONFIG_ARG = "--config";
const TRANSPORT_ARG = "--transport";
const PORT_ARG = "--port";
const HOST_ARG = "--host";
const DEFAULT_CONFIG_PATH = "/app/mcp.json";

// expand a leading "~" to the user's home directory, since the proxy may be
// spawned without a shell (e.g. by an MCP client) where "~" is not expanded.
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return `${homedir()}${p.slice(1)}`;
  return p;
}

// CLI options the proxy understands.
interface CliArgs {
  configPath: string;
  transport: "stdio" | "http";
  port: number;
  host: string;
}

// read a required CLI value following the given flag; throws if missing.
function readValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
}

// parse CLI arguments. stdio is the default transport; http is opt-in.
function parseArgs(argv: string[]): CliArgs {
  const configPath =
    expandHome(readValue(argv, CONFIG_ARG) ?? process.env.MCP_CONFIG_PATH ?? DEFAULT_CONFIG_PATH);
  const transport = (readValue(argv, TRANSPORT_ARG) ?? "stdio") as CliArgs["transport"];
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`unsupported --transport "${transport}" (expected "stdio" or "http")`);
  }
  const port = readValue(argv, PORT_ARG) !== undefined ? Number(readValue(argv, PORT_ARG)) : 3000;
  const host = readValue(argv, HOST_ARG) ?? "0.0.0.0";
  return { configPath, transport, port, host };
}

async function main(): Promise<void> {
  // parse CLI, load config, and build the backend manager.
  const { configPath, transport, port, host } = parseArgs(process.argv.slice(2));
  const config = loadConfig(configPath);
  const backends = new BackendManager(config.mcpServers);

  // eagerly load the tool schemas of any favorite backends so they are injected
  // into context up front (remaining backends stay lazy). also returns a map of
  // each eager tool name to its owning backend so direct calls route correctly.
  const { tools: favoriteTools, owner: favoriteOwner } = await backends.loadFavorites();

  // shared shutdown: close all backend connections.
  const shutdown = async () => {
    await backends.closeAll();
  };

  // build a fresh MCP server with the meta-tool handlers wired in.
  // a new instance is created per HTTP session (one transport per Server).
  // note: we intentionally use the low-level `Server` (deprecated in the SDK in
  // favor of `McpServer`) because tool schemas are discovered at runtime and
  // forwarded by name via call_mcp_tool — the documented advanced use case.
  const buildServer = () => {
    const server = new Server(
      { name: packageJson.name, version: packageJson.version },
      {
        capabilities: { tools: {} },
        instructions: [
          "Lazy MCP proxy. Backend MCP servers are not loaded into context by default; discover them on demand.",
          "Available backends:",
          ...backends
            .list()
            .map((b) => `- ${b.name}: ${b.instruction ?? "no description"}`),
          "Workflow: call get_mcp_tools to load a backend's tool schemas, then call_mcp_tool to invoke one.",
        ].join("\n"),
      },
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

    return server;
  };

  // dispatch on the chosen transport.
  if (transport === "http") {
    // bearer token auth is required in HTTP mode: fail fast if unset.
    const token = process.env.MCP_AUTH_TOKEN;
    if (!token) {
      throw new Error(
        "MCP_AUTH_TOKEN must be set in HTTP mode to protect the endpoint. Refusing to start unauthenticated.",
      );
    }

    const { getPort, close } = await startHttpServer({
      host,
      port,
      buildServer,
      expectedToken: token,
      onShutdown: shutdown,
    });

    const summary = {
      transport: "http",
      port: getPort(),
      backends: backends.list().length,
      favorites: backends.favorites().length,
    };
    console.log(`[mcp-lazy-proxy] ${JSON.stringify(summary, null, 2)}`);

    process.on("SIGINT", async () => {
      await close();
      process.exit(0);
    });
    process.on("SIGTERM", async () => {
      await close();
      process.exit(0);
    });
    return;
  }

  // stdio mode: connect over stdio and clean up backends on shutdown.
  const server = buildServer();
  const transportStream = new StdioServerTransport();
  await server.connect(transportStream);

  const summary = {
    transport: "stdio",
    backends: backends.list().length,
    favorites: backends.favorites().length,
  };
  console.error(`[mcp-lazy-proxy] ${JSON.stringify(summary, null, 2)}`);

  process.on("SIGINT", async () => {
    await shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await shutdown();
    process.exit(0);
  });
  return undefined;
}

await main();
