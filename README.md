# MCP Lazy Proxy

Lazy MCP proxy for LLM clients. Instead of injecting every backend MCP server's tool schemas into the model context, it exposes just two meta-tools — `get_mcp_tools` and `call_mcp_tool` — that load and invoke backend servers on demand. The model sees a tiny, stable tool surface. Backends are connected lazily, their tool lists are cached, and idle connections are closed automatically.

## Why

I run local models on a small mini PC — a KAMRUI Hyper H1 with an AMD Ryzen 7 6800H, 32 GB RAM, and 16 GB of shared UMA vRAM for the iGPU. It works surprisingly well, but context bloat is the one thing that keeps tripping me up the moment I plug in the MCPs I actually use every day.

With 9 MCP servers wired up (GitHub, Sentry, n8n, etc), a plain "hello" was eating roughly 41k of context in opencode — and I only have 64k to play with on local models. A model I really like, Qwen3.5-35B-A3B-UD-IQ3_S, would spend a solid minute chewing through the prompt before it got to do anything useful.

So I wrote this in a single night session. Now my "hello" costs just under 10k of context :>

## Features

- Only two tool schemas injected into the model context, no matter how many backends you configure
- `get_mcp_tools` discovers a backend's tools (with optional name/description filter and result limit)
- `call_mcp_tool` forwards a tool invocation to any backend
- Backends connect lazily on first use and close after 5 minutes idle
- Supports both remote (HTTP/Streamable) and local (stdio subprocess) MCP servers
- Per-backend `instruction` lets you tell the model what each MCP is for
- Advertises the backend catalog via MCP `instructions`, so the model knows what's available up front
- Mark a backend as a `favorite` to inject its schemas eagerly while the rest stay lazy

## Quick start

**Requirements:** Node.js 18+. Install and build:

```bash
npm install
npm run build
```

Create a config file pointing at your MCP servers. See [Configuration](#configuration) for the full shape.

```json
{
  "mcpServers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer <TOKEN>" },
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

Point your MCP client at it as a stdio server. For example, in an MCP client config:

```json
{
  "mcpServers": {
    "lazy-proxy": {
      "command": "node",
      "args": ["/path/to/mcp-lazy-proxy/dist/index.js", "--config", "/path/to/mcp.json"]
    }
  }
}
```

## Configuration

The proxy takes a single JSON config file via `--config <path>`. It must have an `mcpServers` object; each entry is a backend with either a `url` (remote) or a `command` (local).

### Backend reference

| Field         | Required | Description                                                                 |
| ------------- | -------- | --------------------------------------------------------------------------- |
| `url`         | Remote   | HTTP(S) endpoint of a remote MCP server (Streamable HTTP).                  |
| `headers`     | No       | Extra headers for the remote server, e.g. `Authorization`.                  |
| `command`     | Local    | Executable to spawn for a local stdio MCP server.                           |
| `args`        | No       | Arguments passed to the local command.                                      |
| `env`         | No       | Extra environment variables for the local command.                           |
| `instruction` | No       | Human/LLM-facing description of what this MCP is for. Shown in the catalog and returned by `get_mcp_tools`. Falls back to the mcp server's own instructions when omitted. |
| `favorite`    | No       | `true` to inject this backend's tool schemas eagerly into the model context instead of keeping it lazy. See [Favorites](#favorites). |

## Using the proxy

The proxy advertises two meta-tools to the model.

### `get_mcp_tools`

Discover what a backend can do before calling it. Returns the backend's instruction plus a filtered list of tool names, descriptions, and input schemas.

| Argument | Type   | Description                                                       |
| -------- | ------ | ----------------------------------------------------------------- |
| `mcp`    | string | Name of the MCP backend from the proxy config.                    |
| `query`  | string | Optional substring filter on tool name/description.               |
| `limit`  | number | Optional cap on results (default 50).                             |

### `call_mcp_tool`

Invoke a tool on a backend. Use the tool name and arguments returned by `get_mcp_tools`.

| Argument    | Type   | Description                                        |
| ----------- | ------ | -------------------------------------------------- |
| `mcp`       | string | Name of the MCP backend from the proxy config.     |
| `tool`      | string | Tool name as returned by `get_mcp_tools`.          |
| `arguments` | object | Arguments per the tool's input schema.             |

### Workflow

1. The model reads the advertised catalog (backend names + instructions).
2. It calls `get_mcp_tools` to load a backend's schemas.
3. It calls `call_mcp_tool` to run a tool, passing the discovered arguments.

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

## Contributing

Want to change code, fix bugs, or improve docs? The project is a small TypeScript MCP server. `src/index.ts` wires up the meta-tools and eager favorites, `src/backend.ts` manages lazy connections and caching, and `src/config.ts` parses the config. Run `npm run typecheck` to typecheck, `node smoke.mjs` for a smoke test, and `node bench.mjs` for the benchmark against your local MCP config.

<p align="left">
  With love from India 🇮🇳
</p>
