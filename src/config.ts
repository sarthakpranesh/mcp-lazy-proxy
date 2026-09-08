import { readFileSync } from "node:fs";

// remote backend: reachable over HTTP(S) via a URL.
export interface RemoteBackendConfig {
  type?: "remote";
  url: string;
  headers?: Record<string, string>;
}

// local backend: spawned as a stdio subprocess.
export interface LocalBackendConfig {
  type: "local";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

// a backend is either remote or local, plus an optional LLM-facing description.
export type BackendConfig = (RemoteBackendConfig | LocalBackendConfig) & {
  /** Optional human/LLM-facing description of what this MCP is for. */
  instruction?: string;
};

// top-level shape of the proxy config file.
export interface ProxyConfig {
  mcpServers: Record<string, BackendConfig>;
}

// parse and validate the config file, ensuring every server has url or command.
export function loadConfig(path: string): ProxyConfig {
  const raw = readJson(path);
  const servers = raw.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error(`config "${path}" must have an "mcpServers" object`);
  }
  // validate that each server has a url or command
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== "object") {
      throw new Error(`mcp server "${name}" must be an object`);
    }
    const hasUrl = typeof (cfg as RemoteBackendConfig).url === "string";
    const hasCommand = typeof (cfg as LocalBackendConfig).command === "string";
    if (!hasUrl && !hasCommand) {
      throw new Error(`mcp server "${name}" must have a "url" or "command"`);
    }
  }
  return { mcpServers: servers as Record<string, BackendConfig> };
}

// read and parse a JSON file into a plain object.
function readJson(path: string): Record<string, unknown> {
  const text = readFileSync(path, "utf8");
  return JSON.parse(text);
}
