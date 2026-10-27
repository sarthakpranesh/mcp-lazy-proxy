# MCP Lazy Proxy

Lazy MCP proxy for LLM clients. Instead of injecting every backend MCP server's tool schemas into the model context, it exposes two meta-tools — `get_mcp_tools` and `call_mcp_tool` — that load and invoke backend servers on demand, plus `get_mcp_file` when a files dir is configured. The model sees a tiny, stable tool surface. Backends are connected lazily, their tool lists are cached, and idle connections are closed automatically.

[![Listed on MCP Market](https://mcpmarket.com/badge/server/lazy-proxy-1.svg)](https://mcpmarket.com/server/lazy-proxy-1?utm_source=readme&utm_medium=badge)

## Why

I run local models on a small mini PC — a KAMRUI Hyper H1 with an AMD Ryzen 7 6800H, 32 GB RAM, and 16 GB of shared UMA vRAM for the iGPU. It works surprisingly well, but context bloat is the one thing that keeps tripping me up the moment I plug in the MCPs I actually use every day.

With 9 MCP servers wired up (GitHub, Sentry, n8n, etc), a plain "hello" was eating roughly 41k of context in opencode — and I only have 64k to play with on local models. A model I really like, Qwen3.5-35B-A3B-UD-IQ3_S, would spend a solid minute chewing through the prompt before it got to do anything useful.

So I wrote this in a single night session. Now my "hello" costs just under 10k of context :>

## What makes this different

Other lazy MCP proxies are all-or-nothing: they either keep every backend lazy or inject everything eagerly. This proxy is the only one that lets you pick a middle ground.

- **Favorites** — mark a handful of backends you reach for every session as `favorite` and their schemas are injected up front (no discovery round-trip), while the rest stay lazy. A real context-vs-latency knob, not a binary choice.
- **Live discovery, no build step** — tools are fetched on demand at runtime. No pre-generated tool hierarchy to keep in sync.
- **Filtered discovery** — `get_mcp_tools` takes `query` and `limit`, so the model pulls only the relevant subset of a backend's schemas.
- **Connection lifecycle** — backends connect lazily and auto-close after 5 minutes idle, so resources aren't held for the whole session.
- **Remote + local** — one proxy handles both HTTP/Streamable and stdio backends.
- **Measured, not guessed** — `bench.mjs` quantifies the lazy/favorites/all-eager tradeoff with real numbers.

## Features

- Two meta-tools injected by default (`get_mcp_tools`, `call_mcp_tool`), plus `get_mcp_file` when a files dir is configured; `favorite` backend schemas are injected on top
- `get_mcp_tools` discovers a backend's tools (with optional name/description filter and result limit)
- `call_mcp_tool` forwards a tool invocation to any backend and returns its result unchanged
- `get_mcp_file` hands backend-written artifacts to the model as an embedded resource, so retrieving a file never depends on filesystem access to the proxy host
- Backends connect lazily on first use and close after 5 minutes idle
- Supports both remote (HTTP/Streamable) and local (stdio subprocess) MCP servers
- Per-backend `instruction` lets you tell the model what each MCP is for
- Advertises the backend catalog via MCP `instructions`, so the model knows what's available up front
- Mark a backend as a `favorite` to inject its schemas eagerly while the rest stay lazy

## Quick start

The proxy runs in one of two modes:

| Mode | How it runs | Traffic flow |
| ---- | ----------- | ------------ |
| **Stdio (local)** | Spawned as a subprocess by your MCP client (default). | Proxy talks to backends directly from your machine. **No network server is started and no remote proxy call is made** — it all happens in-process over stdio, local to your client. Best for a single machine. |
| **Self-hosted HTTP (shared)** | Runs as a long-lived HTTP server (e.g. in Docker) on one host. | The proxy is a **central gate for all MCP calls** for every machine/agent — each client talks to the proxy over HTTP with a bearer token, and the proxy fans out to backends on its own host. Best for a team sharing one config. |

In both modes the model sees the same two meta-tools (`get_mcp_tools`, `call_mcp_tool`), plus `get_mcp_file` when a files dir is configured; only the transport differs.

Start with a config file pointing at your MCP servers. See [Configuration](#configuration) for the full shape.

```json
{
  "mcpServers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" },
      "instruction": "GitHub: issues, pull requests, code search. Use for anything repo-related."
    },
    "local-tool": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "instruction": "A local stdio MCP server."
    }
  }
}
```

### Option A — Stdio (local, default)

Point your MCP client at it as a stdio server. No network server is started and no remote call is made — the proxy runs as a subprocess on the same machine as your client. For example, in an MCP client config:

```json
{
  "mcpServers": {
    "lazy-proxy": {
      "command": "npx",
      "args": ["-y", "@sarthakpranesh/mcp-lazy-proxy", "--config", "/path/to/mcp.json"]
    }
  }
}
```

If a backend writes files (screenshots, exports), set `filesEnv` on it: the model then reads those files with `get_mcp_file` instead of directly accessing the files on the proxied backend.

### Option B — Self-hosted HTTP (shared)

Run the proxy as a shared, long-lived HTTP server (e.g. in Docker) that many clients connect to over the network. No web UI — clients reach the same meta-tools (`get_mcp_tools`, `call_mcp_tool`, plus `get_mcp_file` when a files dir is configured) over MCP Streamable HTTP at `POST /mcp`. The proxy becomes the **single central gate**: every MCP call from every user machine/agent flows through it, and it fans out to backends on its own host.

1. Create `.env` with the shared bearer token and any backend secrets. Start from the example:
```dotenv
# shared token every client must send, for auth
MCP_AUTH_TOKEN=change-me-to-a-long-random-string

# MCP server tokens used by backends in the proxy
# referenced by mcp.json
GITHUB_TOKEN=ghp_xxxx                   
```

> Generate a strong token, e.g. `openssl rand -hex 32`.

2. Define `docker-compose.yml` to build and run the proxy container, exposing `3000`, mounting `mcp.json` read-only, and passing the env vars through:

```yaml
services:
  mcp-lazy-proxy:
    image: sarthakpranesh/mcp-lazy-proxy
    ports:
      - "3000:3000"
    env_file:
      - .env
    volumes:
      - ./mcp.json:/app/mcp.json:ro
    restart: unless-stopped
```

3. Start it
```bash
docker compose up -d
```

4. Each machine connects with a single entry in its MCP client config:
```json
{
  "mcpServers": {
    "lazy-proxy": {
      "type": "http",
      "url": "http://<host>:3000/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

Notes:
- **Local stdio backends now run on the proxy host, not the client.** Backends defined with `command` (plus any local files they need) must exist and be reachable inside the container. Remote (`url`) backends behave the same as in stdio mode.
- **Auth is mandatory.** In HTTP mode the proxy refuses to start unless `MCP_AUTH_TOKEN` is set. Every request to `/mcp` must carry `Authorization: Bearer <token>` or it is rejected with `401`.
- **Secrets stay out of the mounted config.** `mcp.json` can reference environment variables with `${VAR}` (e.g. `"Authorization": "Bearer ${GITHUB_TOKEN}"`) and they are substituted from `process.env` at load time.
- **Config** still comes from `--config` (default `/app/mcp.json`, matching the container mount). The CLI flags are: `--transport http` (stdio is the default), `--port <n>` (default `3000`), `--host <addr>` (default `0.0.0.0`).
- **Files written by backends are reachable.** A backend opts in with `filesEnv` — the name of the env var it reads (`"IMAGE_DIR"` for figma) — and the proxy points that var at a private dir under the OS temp dir. In HTTP mode that dir is also served at `GET /files/<path>` behind the same auth; in both transports the model fetches it through `get_mcp_file`, so a client that cannot reach the proxy host still gets the bytes. The dir is wiped on startup, so a path or link stops working once the proxy restarts.

```bash
curl -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  http://localhost:3000/files/image34.png -o image34.png
```

**Rotating the bearer token:** generate a new value, set it in `.env` as `MCP_AUTH_TOKEN`, then `docker compose up -d` to recreate the container. Existing clients must be updated with the new token — old tokens are rejected immediately because each request is checked against the current value.

## Configuration

The proxy takes a single JSON config file via `--config <path>`. It must have an `mcpServers` object; each entry is a backend with either a `url` (remote) or a `command` (local). Any `${VAR}` reference inside the file is substituted from `process.env` at load time, so secrets can live in environment variables instead of the mounted file.

### Backend reference

| Field         | Required | Description                                                                 |
| ------------- | -------- | --------------------------------------------------------------------------- |
| `url`         | Remote   | HTTP(S) endpoint of a remote MCP server (Streamable HTTP).                  |
| `headers`     | No       | Extra headers for the remote server, e.g. `Authorization`.                  |
| `command`     | Local    | Executable to spawn for a local stdio MCP server.                           |
| `args`        | No       | Arguments passed to the local command.                                      |
| `env`         | No       | Extra environment variables for the local command.                           |
| `filesEnv`    | No       | Opt in: env var that receives the shared files dir, so the backend's output can be fetched from `/files/*` (HTTP) or `get_mcp_file` (both transports), e.g. `IMAGE_DIR` for figma. Nothing is injected unless set. |
| `instruction` | No       | Human/LLM-facing description of what this MCP is for. Shown in the catalog and returned by `get_mcp_tools`. Falls back to the mcp server's own instructions when omitted. |
| `favorite`    | No       | `true` to inject this backend's tool schemas eagerly into the model context instead of keeping it lazy. See [Favorites](#favorites). |

## Using the proxy

The proxy advertises two meta-tools to the model, plus `get_mcp_file` when a files dir is configured.

### `get_mcp_tools`

Discover what a backend can do before calling it. Returns the backend's instruction plus a filtered list of tool names, descriptions, input and output schemas, titles, and annotations.

| Argument | Type   | Description                                                       |
| -------- | ------ | ----------------------------------------------------------------- |
| `mcp`    | string | Name of the MCP backend from the proxy config.                    |
| `query`  | string | Optional substring filter on tool name/description.               |
| `limit`  | number | Optional cap on results (default 50).                             |

Backend `tools/list` pagination is merged before `limit` is applied, so a paged backend loses nothing.

### `call_mcp_tool`

Invoke a tool on a backend. Use the tool name and arguments returned by `get_mcp_tools`.

| Argument    | Type   | Description                                        |
| ----------- | ------ | -------------------------------------------------- |
| `mcp`       | string | Name of the MCP backend from the proxy config.     |
| `toolName`  | string | Tool name as returned by `get_mcp_tools`. |
| `arguments` | object | Arguments per the tool's input schema.             |

The backend's result is returned verbatim: all content blocks, `structuredContent`, and `isError` pass through unchanged.

### `get_mcp_file`

Fetch a file a backend wrote to the proxy. Advertised only when at least one backend sets `filesEnv` — without an opt-in there is no files dir in either transport, because a path on the proxy host is not something the client can open itself.

| Argument   | Type    | Description                                                                                   |
| ---------- | ------- | --------------------------------------------------------------------------------------------- |
| `path`     | string  | The path the backend returned. An absolute path inside the files dir, a name relative to it, and `/files/...` URLs all resolve to the same file. |
| `maxBytes` | number  | Optional size cap (default 10 MB). Larger files are refused, never truncated.                 |

Every file comes back as an embedded resource (`uri`, `mimeType`, base64 `blob`); the `uri` points at `GET /files/<path>` when the proxy serves HTTP and at `file://<path>` in stdio, where there is no route. Traversal (`..`), absolute paths outside the dir, and escaping symlinks are rejected.

### Workflow

1. The model reads the advertised catalog (backend names + instructions).
2. It calls `get_mcp_tools` to load a backend's schemas.
3. It calls `call_mcp_tool` to run a tool, passing the discovered arguments.
4. If the result points at a file the backend wrote, it calls `get_mcp_file` to fetch the bytes.

## Favorites

All-lazy guarantees the smallest context footprint, but every call first pays a `get_mcp_tools` round-trip to bring the backend's schemas into context. Mark a backend as a `favorite` and its schemas are injected up front instead — so the model can call its tools directly, no discovery step required. The rest stay lazy.

```json
{
  "mcpServers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer <TOKEN>" },
      "favorite": true,
      "instruction": "GitHub: issues, pull requests, code search."
    }
  }
}
```

Pick a handful you reach for every session; leave long-tail backends lazy.

## Benchmark

`bench.mjs` compares three modes against a backend of your choice: all-lazy, favorites (that one backend eager), and all-eager. It measures injected schemas, approximated context tokens, and end-to-end latency of one real tool call ( skips the impact added from extra inference required from get_mcp_tools to call_mcp_tool, but added manually ).

```bash
npm run build
node bench.mjs            # defaults to the github backend
BENCH_MCP="promptify" BENCH_TOOL="get_prompts" node bench.mjs
```

Sample output for `BENCH_MCP=github` and `BENCH_TOOL=get_me`:

| mode      | injected tools | context (approx tokens) | end-to-end call | impact from added inference |
| --------- | -------------- | ----------------------- | --------------- | --------------------------- |
| lazy      | 2              | 167                     | 3.69s           | high                        |
| favorites | 46             | 9845                    | 437ms           | non fav - high, fav - none  |
| all       | 118            | 31820                   | 417ms           | none                        |

Lazy is 2 tools here because the github backend is remote and writes no files, so `get_mcp_file` is not advertised; a config with a `filesEnv` backend adds it as a third.

Impact on context: github mcp as favorite adds 9678 tokens vs all-lazy this is highly dependent on which mcp(s) you add to favorites; all-eager adds 31820 tokens for all my 9 MCPs vs all-lazy.

latency: favorites first-call 3.25s faster than all-lazy, without the time taken in inference from get_mcp_tools to call_mcp_tool. For cloud models this will be fast, for local models this might add a second.

The numbers are approximate — token count is estimated at 4 chars/token and excludes the model's own prompt overhead — but the shape is consistent: all-lazy is the cheapest, all-eager the fastest, favorites sits somewhere in the middle.

## Troubleshooting

| Problem                          | What to try                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `unknown mcp server "X"`         | The name must match a key in `mcpServers` exactly.                                                   |
| `must have a "url" or "command"` | Every backend needs one of the two; check the config for typos.                                      |
| Backend not reachable            | For remote servers, confirm the URL and `Authorization` header are correct.                          |
| Model calls a tool that doesn't exist | Run `get_mcp_tools` first to see the real tool names and schemas before calling.                |
| Backend keeps reconnecting       | Connections close after 5 minutes idle by design; that's expected.                                   |
| `get_mcp_file` missing from the tool list | It is only advertised when at least one backend sets `filesEnv`. |
| `file not found` from `get_mcp_file` | Pass the path the backend returned, or a name relative to the proxy files dir. |

## Contributing

Want to change code, fix bugs, or improve docs? The project is a small TypeScript MCP server. `src/index.ts` wires up the meta-tools and eager favorites, `src/backend.ts` manages lazy connections and caching, `src/files.ts` guards the artifact dir, and `src/config.ts` parses the config. Run `npm run typecheck` to typecheck, `npm test` for the unit tests, `node smoke.mjs` for the end-to-end smoke test, and `node bench.mjs` for the benchmark against your local MCP config.

<p align="left">
  With love from India 🇮🇳
</p>
