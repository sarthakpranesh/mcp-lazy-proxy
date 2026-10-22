import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { BackendConfig } from "./config.js";
import packageJson from "../package.json" with { type: "json" };

// a single tool exposed by a backend, as surfaced to the model.
// kept as the SDK's own Tool shape so discovery stays lossless (outputSchema,
// title, annotations, icons, ... all pass through unchanged).
export type BackendTool = Tool;

// the eagerly-injected favorite schemas and the tool name -> owner map used to
// route direct calls to the right backend.
export interface FavoriteTools {
  tools: BackendTool[];
  owner: Map<string, { backend: string; realToolName: string }>;
}

// opaque handle to a connected backend for the tool handlers.
export interface BackendHandle {
  instruction?: string;
  listTools(query?: string, limit?: number): Promise<BackendTool[]>;
  callTool(tool: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

// lightweight catalog entry used by list_mcps.
export interface BackendSummary {
  name: string;
  instruction?: string;
}

// the idle timeout for a backend connection
const IDLE_TIMEOUT_MS = 5 * 60_000;
// hard cap on tools/list pages per discovery. guards against a misbehaving
// backend that keeps returning a cursor: without it, the loop never ends.
const MAX_TOOL_PAGES = 10;

// lazily connects to backends, caches their tool lists, and closes on idle.
export class BackendManager {
  private readonly clients = new Map<string, Client>();
  private readonly tools = new Map<string, BackendTool[]>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();

  // eagerly-injected favorite schemas plus the map that routes direct calls.
  // rebuilt lazily after a favorite reports a tools/list_changed.
  private favoritesCache?: FavoriteTools;
  private favoritesStale = false;

  constructor(private readonly configs: Record<string, BackendConfig>) {}

  // return the catalog of configured backends (name + instruction).
  list(): BackendSummary[] {
    return Object.entries(this.configs).map(([name, cfg]) => ({
      name,
      instruction: cfg.instruction,
    }));
  }

  // return the names of backends flagged as favorites (eagerly loaded).
  favorites(): string[] {
    return Object.entries(this.configs)
      .filter(([, cfg]) => cfg.favorite)
      .map(([name]) => name);
  }

  // return the cached favorite schemas, rebuilding them only when a favorite
  // reported a change. one promise means callers never load them twice.
  async favoriteTools(): Promise<FavoriteTools> {
    if (this.favoritesCache && !this.favoritesStale) return this.favoritesCache;
    // clear before awaiting so a change landing mid-rebuild leaves it dirty.
    this.favoritesStale = false;
    const fresh = await this.loadFavorites();
    this.favoritesCache = fresh;
    return fresh;
  }

  // eagerly connect to the favorite backends and collect their tool schemas,
  // along with a map of each tool name to its owning backend.
  // a backend that fails to load is skipped so one bad favorite can't crash the proxy.
  private async loadFavorites(): Promise<FavoriteTools> {
    const names = this.favorites();
    const sets = await Promise.all(
      names.map(async (n) => {
        try {
          return { name: n, tools: await this.listTools(n) };
        } catch {
          return { name: n, tools: [] as BackendTool[] };
        }
      }),
    );
    const tools: BackendTool[] = [];
    const owner = new Map<string, { backend: string; realToolName: string }>();
    for (const s of sets) {
      for (const t of s.tools) {
        // tool names are prefixed with the backend name so same-named tools from
        // different backends (e.g. promptify vs promptify_personal) don't collide.
        // has two underscores to separate the backend name from the tool name
        const prefixed = `${s.name}__${t.name}`;
        tools.push({ ...t, name: prefixed });
        if (!owner.has(prefixed)) owner.set(prefixed, {
          backend: s.name,
          realToolName: t.name,
        });
      }
    }
    return { tools, owner };
  }

  // get a handle to a backend, connecting lazily and resetting its idle timer.
  async get(name: string): Promise<BackendHandle> {
    const cfg = this.configs[name];
    if (!cfg) {
      throw new Error(`unknown mcp server "${name}"`);
    }
    const client = await this.connect(name, cfg);
    this.resetIdleTimer(name);
    return {
      instruction: cfg.instruction ?? client.getInstructions(),
      listTools: (query, limit) => this.listTools(name, query, limit),
      callTool: (tool, args) => this.callTool(name, tool, args),
      close: () => this.close(name),
    };
  }

  // connect to a backend if not already connected, reusing the cached client.
  private async connect(name: string, cfg: BackendConfig): Promise<Client> {
    const existing = this.clients.get(name);
    if (existing) return existing;

    const transport = this.buildTransport(cfg);

    // create a new client with the package name and version
    const client = new Client({ name: packageJson.name, version: packageJson.version });

    // drop the cached tool list when the backend says it changed, so the next
    // discovery re-fetches instead of serving stale schemas. this is what makes
    // long-lived connections notice backend restarts/updates.
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      this.tools.delete(name);
      if (this.configs[name]?.favorite) this.favoritesStale = true;
    });

    await client.connect(transport);

    // cache the client
    this.clients.set(name, client);
    return client;
  }

  // build the SDK transport for a backend (HTTP for url, stdio for command).
  private buildTransport(cfg: BackendConfig) {
    // build the transport for a remote backend
    if ("url" in cfg && cfg.url) {
      return new StreamableHTTPClientTransport(new URL(cfg.url), {
        requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
      });
    }

    // build the transport for a local backend
    const local = cfg as { command: string; args?: string[]; env?: Record<string, string> };
    return new StdioClientTransport({
      command: local.command,
      args: local.args ?? [],
      env: local.env,
    });
  }

  // list a backend's tools, caching them and applying optional query/limit filters.
  private async listTools(name: string, query?: string, limit?: number): Promise<BackendTool[]> {
    // get the cached tools for the backend
    let tools = this.tools.get(name);
    if (!tools) {
      tools = await this.fetchAllTools(name, this.configs[name]);
      this.tools.set(name, tools);
    }

    // apply the optional query/limit filters
    let filtered = tools;
    if (query) {
      const q = query.toLowerCase();
      filtered = tools.filter(
        (t) => t.name.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q),
      );
    }
    if (limit && limit > 0) {
      filtered = filtered.slice(0, limit);
    }
    return filtered;
  }

  // walk tools/list pages until the backend stops returning a cursor.
  private async fetchAllTools(name: string, cfg: BackendConfig): Promise<BackendTool[]> {
    const client = await this.connect(name, cfg);
    const tools: BackendTool[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let pages = 0; pages < MAX_TOOL_PAGES; pages++) {
      const res = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...(res.tools ?? []));
      cursor = res.nextCursor;
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    if (cursor) {
      console.error(`[mcp-proxy] ${name}: stopped after ${MAX_TOOL_PAGES} pages; tool list may be incomplete`);
    }
    return tools;
  }

  // forward a tool call to a backend and return its full result, preserving
  // content blocks, structuredContent, and isError for the client.
  private async callTool(
    name: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const client = await this.connect(name, this.configs[name]);
    return (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
  }

  // reset the idle-close timer for a backend on each use.
  // used to keep the backend connection alive for a period of time after the last use.
  private resetIdleTimer(name: string) {
    const existing = this.idleTimers.get(name);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => void this.close(name), IDLE_TIMEOUT_MS);
    timer.unref?.();
    this.idleTimers.set(name, timer);
  }

  // close a backend's connection and drop its cached tools/timer.
  private async close(name: string) {
    // clear the idle timer
    const timer = this.idleTimers.get(name);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(name);

    // delete the cached tools
    this.tools.delete(name);

    // close the client
    const client = this.clients.get(name);
    if (client) {
      this.clients.delete(name);
      try {
        await client.close();
      } catch {
        // best-effort: ignore errors closing the client
      }
    }
  }

  // close every connected backend (used on shutdown).
  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.keys()].map((n) => this.close(n)));
  }
}
