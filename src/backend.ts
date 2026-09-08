import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { BackendConfig } from "./config.js";
import packageJson from "../package.json" with { type: "json" };

// a single tool exposed by a backend, as surfaced to the model.
export interface BackendTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

// opaque handle to a connected backend for the tool handlers.
export interface BackendHandle {
  instruction?: string;
  listTools(query?: string, limit?: number): Promise<BackendTool[]>;
  callTool(tool: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

// lightweight catalog entry used by list_mcps.
export interface BackendSummary {
  name: string;
  instruction?: string;
}

// the idle timeout for a backend connection
const IDLE_TIMEOUT_MS = 5 * 60_000;

// lazily connects to backends, caches their tool lists, and closes on idle.
export class BackendManager {
  private readonly clients = new Map<string, Client>();
  private readonly tools = new Map<string, BackendTool[]>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();

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

  // eagerly connect to the favorite backends and collect their tool schemas,
  // along with a map of each tool name to its owning backend.
  // a backend that fails to load is skipped so one bad favorite can't crash the proxy.
  async loadFavorites(): Promise<{ tools: BackendTool[]; owner: Map<string, string> }> {
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
    const tools = sets.flatMap((s) => s.tools);
    const owner = new Map<string, string>();
    for (const s of sets) {
      for (const t of s.tools) {
        if (!owner.has(t.name)) owner.set(t.name, s.name);
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
    const client = await this.connect(name, this.configs[name]);

    // get the cached tools for the backend
    let tools = this.tools.get(name);
    if (!tools) {
      const res = await client.listTools();
      tools = (res.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown> | undefined,
      }));
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

  // forward a tool call to a backend and return its raw result content.
  private async callTool(
    name: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const client = await this.connect(name, this.configs[name]);
    const res = await client.callTool({ name: tool, arguments: args });
    return res.content ?? res;
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
