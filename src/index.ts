#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { BackendManager } from "./backend.js";
import { startHttpServer } from "./server.js";
import { readFileWithin } from "./files.js";
import packageJson from "../package.json" with { type: "json" };

const CONFIG_ARG = "--config";
const TRANSPORT_ARG = "--transport";
const PORT_ARG = "--port";
const HOST_ARG = "--host";
const DEFAULT_CONFIG_PATH = "/app/mcp.json";

// backend artifacts are screenshots and exports; 10 MB covers a phone screenshot
// with room to spare while keeping one tool result from flooding a context window.
const DEFAULT_INLINE_MAX_BYTES = 10 * 1024 * 1024;

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

// origin clients can actually reach for /files/*: a wildcard bind address is not
// a hostname, so fall back to loopback.
function publicHost(host: string): string {
  return host === "0.0.0.0" || host === "::" || host === "" ? "127.0.0.1" : host;
}

// create the shared scratch dir that backends write into and /files/* serves.
function prepareFilesDir(): string {
  // tmp is writable by any user, so no image or volume setup is needed. 0700
  // keeps backend artifacts private on multi-user hosts.
  const dir = join(tmpdir(), "mcp-lazy-proxy-files");
  // start from a clean slate: artifacts from a previous run must not linger, since
  // every backend shares this one dir and nothing else prunes it.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

async function main(): Promise<void> {
  // parse CLI, load config, and build the backend manager.
  const { configPath, transport, port, host } = parseArgs(process.argv.slice(2));

  const config = loadConfig(configPath);

  // a files dir exists only when a backend opts in with filesEnv — that is the
  // only way anything can write into it, so no opt-in means no dir and no
  // get_mcp_file tool in either transport.
  const hasFilesEnvBackend = Object.values(config.mcpServers).some(
    (cfg) => "filesEnv" in cfg && Boolean(cfg.filesEnv),
  );
  const filesDir = hasFilesEnvBackend ? prepareFilesDir() : undefined;

  const backends = new BackendManager(config.mcpServers, filesDir);

  // precache the favorite backend list
  await backends.favoriteTools();

  // shared shutdown: close all backend connections.
  const shutdown = async () => {
    await backends.closeAll();
  };

  // base for resource URIs; set once the http server is listening, so stdio keeps
  // a file:// URI (there is no /files route there) and http points at the route.
  let filesUrlBase: string | undefined;

  // build a fresh MCP server with the meta-tool handlers wired in.
  // a new instance is created per HTTP session (one transport per Server).
  // note: we intentionally use the low-level `Server` (deprecated in the SDK in
  // favor of `McpServer`) because tool schemas are discovered at runtime and
  // forwarded by name via call_mcp_tool — the documented advanced use case.
  const buildServer = () => {
    // one bullet per configured backend, shared by the server `instructions` and
    // the get_mcp_tools description so the two can never drift apart.
    const backendList = backends
      .list()
      .map((b) => `- ${b.name}: ${b.instruction ?? "no description"}`)
      .join("\n");

    // the usage guidance, likewise shared between instructions and the tool
    // description.
    const workflow =
      "Workflow: call get_mcp_tools to load a backend's tool schemas, then call_mcp_tool to invoke one." +
      (filesDir
        ? " A backend's files are only reachable through the proxy: fetch them with get_mcp_file using the path the backend returned."
        : "");

    const server = new Server(
      { name: packageJson.name, version: packageJson.version },
      {
        capabilities: { tools: {} },
        instructions: [
          "Lazy MCP proxy. Backend MCP servers are not loaded into context by default; discover them on demand.",
          "Available backends:",
          backendList,
          workflow,
        ].join("\n"),
      },
    );

    // advertise the meta-tools plus any eagerly-loaded favorite backend schemas.
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const { tools: favoriteTools } = await backends.favoriteTools();
      return {
        tools: [
          ...favoriteTools,
          {
            name: "get_mcp_tools",
            description:
              "Discover the tools exposed by a configured MCP backend. Returns the backend's instruction (if any) plus a filtered list of tool names, descriptions, and input schemas. Call this before call_mcp_tool to learn what a backend can do.\n" +
              // also embedded here because tool descriptions are always injected
              // into the model context, unlike the server `instructions` which
              // some clients (e.g. n8n) drop.
              "Available backends:\n" +
              backendList +
              "\n" +
              workflow,
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
              "Invoke a tool on a configured MCP backend. Set toolName to the tool name returned by get_mcp_tools and pass its arguments.",
            inputSchema: {
              type: "object",
              properties: {
                mcp: { type: "string", description: "Name of the MCP backend from the proxy config." },
                // NOTE: the backend tool name is exposed as "toolName", not "tool".
                // some clients (e.g. n8n's agent) reserve "tool" for their own use and
                // strip it from arguments before forwarding, which silently empties it.
                toolName: { type: "string", description: "Tool name as returned by get_mcp_tools." },
                arguments: {
                  type: "object",
                  description: "Arguments per the tool's input schema.",
                  additionalProperties: true,
                },
              },
              required: ["mcp", "toolName", "arguments"],
            },
          },
          // only advertised when there is a files dir; otherwise the model would
          // call a tool that can never succeed.
          ...(filesDir
            ? [
                {
                  name: "get_mcp_file",
                  description:
                    "Fetch a file that a backend wrote to the proxy (screenshots, exports, generated reports). " +
                    "Pass the path exactly as the backend returned it — an absolute path inside the proxy files dir, a name relative to it, and /files/... URLs all work. " +
                    "Returns the file as an embedded resource (uri, mimeType, base64 blob). " +
                    "maxBytes allows a larger file than the default.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      path: {
                        type: "string",
                        description: "Path the backend returned, e.g. /tmp/mcp-lazy-proxy-files/out/shot.png.",
                      },
                      maxBytes: {
                        type: "number",
                        description: `Optional size limit (default ${DEFAULT_INLINE_MAX_BYTES}).`,
                      },
                    },
                    required: ["path"],
                  },
                },
              ]
            : []),
        ],
      };
    });

    // handle calls to the two meta-tools, dispatching to the right backend.
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    // debug: log the raw inbound tool name and arguments. stderr is used because
    // stdout is the protocol channel in stdio mode; logging there would corrupt it.
    console.error(`[mcp-proxy] CallTool name=${JSON.stringify(name)} args=${JSON.stringify(args)}`);
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
        const tool = String(args?.toolName ?? "");
        const toolArgs = (args?.arguments ?? {}) as Record<string, unknown>;
        const handle = await backends.get(mcp);
        const result = await handle.callTool(tool, toolArgs);
        // return the backend's result untouched so content blocks,
        // structuredContent, and isError reach the client intact.
        return result;
      }

      // get_mcp_file: hand back a file a backend wrote into the files dir, so a
      // client that cannot reach the proxy host (or runs over stdio) still gets
      // the bytes. containment checks live in resolveWithin.
      if (name === "get_mcp_file") {
        // not advertised without a files dir, but a client can still call it by
        // name, so answer with a reason instead of failing through the catch.
        if (!filesDir) {
          return {
            content: [
              {
                type: "text",
                text: "get_mcp_file is unavailable: no backend sets filesEnv, so there is no files directory",
              },
            ],
            isError: true,
          };
        }
        const raw = String(args?.path ?? "");
        const maxBytes = args?.maxBytes != null ? Number(args.maxBytes) : DEFAULT_INLINE_MAX_BYTES;
        if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
          return {
            content: [{ type: "text", text: "maxBytes must be a positive number" }],
            isError: true,
          };
        }

        const { meta, data } = await readFileWithin(filesDir, raw, maxBytes);

        const uri = filesUrlBase
          ? `${filesUrlBase}${encodeURI(meta.path)}`
          : `file://${join(filesDir, meta.path)}`;

        return {
          content: [
            {
              type: "resource",
              resource: {
                uri,
                mimeType: meta.mimeType,
                blob: data.toString("base64"),
              },
            },
          ],
        };
      }

      // direct call to an injected favorite tool: route to its owning backend.
      const { owner: favoriteOwner } = await backends.favoriteTools();
      const ownerObj = favoriteOwner.get(name);
      if (ownerObj) {
        const handle = await backends.get(ownerObj.backend);
        const result = await handle.callTool(ownerObj.realToolName, (args ?? {}) as Record<string, unknown>);
        // same passthrough as call_mcp_tool: no reshaping of the result.
        return result;
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
      filesDir,
      onShutdown: shutdown,
    });

    filesUrlBase = `http://${publicHost(host)}:${getPort()}/files/`;

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
