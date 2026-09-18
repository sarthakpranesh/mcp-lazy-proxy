import { createServer as createNodeHttpServer, Server as NodeHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  StreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";

// timing-safe token comparison. uses a length check first because
// crypto.timingSafeEqual throws on buffers of differing lengths, then delegates
// to the native constant-time comparison.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

// parse the "Authorization: Bearer <token>" header; returns the bearer token
// or undefined if the header is missing/unparseable.
function bearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return m ? m[1] : undefined;
}

export interface HttpServerOptions {
  host: string;
  port: number;
  /** builds a fresh MCP Server for each client session (one transport per Server). */
  buildServer: () => McpServer;
  /** expected bearer token; when provided, requests without it return 401. */
  expectedToken?: string;
  /** how long a session may sit idle before it is closed and evicted (ms). 0 disables. */
  sessionIdleTimeoutMs?: number;
  /** called on graceful shutdown to close backends. */
  onShutdown?: () => Promise<void>;
}

type Session = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
};

// start a Streamable HTTP MCP server on a single endpoint (POST /mcp).
// clients get their own Server+transport per streamable session, so the proxy
// can serve many concurrent clients while reusing the shared backend manager.
export async function startHttpServer(opts: HttpServerOptions): Promise<{
  server: NodeHttpServer;
  getPort: () => number;
  close: () => Promise<void>;
}> {
  const { buildServer, expectedToken, onShutdown } = opts;
  const sessionIdleTimeoutMs = opts.sessionIdleTimeoutMs ?? 5 * 60_000; // 5 minutes
  const sessions = new Map<string, Session>();

  // evict and close a single session, removing it from the map and stopping
  // its transport so the underlying SSE stream is torn down.
  const evictSession = async (sid: string) => {
    const entry = sessions.get(sid);
    if (!entry) return;
    sessions.delete(sid);
    await entry.transport.close().catch(() => {});
    await entry.server.close().catch(() => {});
  };

  // log each request and its resulting status once the response is finished.
  const logRequest = (req: IncomingMessage, res: ServerResponse, label: string) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const at = new Date().toISOString();
    const onFinish = () => {
      res.removeListener("finish", onFinish);
      console.log(
        `[http] ${at} ${req.method} ${req.url} ${res.statusCode} ${sessionId ? `session=${sessionId}` : ""} ${label}`.trim(),
      );
    };
    res.on("finish", onFinish);
  };

  const nodeServer = createNodeHttpServer(async (req, res) => {
    logRequest(req, res, "");
    // health probe: always allowed, no auth, so container HEALTHCHECK can probe.
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // auth gate: reject anything except a valid bearer token when one is set.
    if (expectedToken) {
      const token = bearerToken(req.headers.authorization);
      if (!token || !safeEqual(token, expectedToken)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }

    // path gate: the MCP endpoint is POST /mcp; everything else is not found.
    if (req.method === "POST" && req.url === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      // resume an existing session via its transport
      if (sessionId && sessions.has(sessionId)) {
        const entry = sessions.get(sessionId)!;
        entry.lastActivity = Date.now();
        await entry.transport.handleRequest(req, res);
        return;
      }

      // new streamable session: create a fresh Server + transport
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      const sessionServer = buildServer();
      await sessionServer.connect(transport);

      // handleRequest populates transport.sessionId for a brand-new session;
      // register it afterwards so subsequent requests can be routed back.
      await transport.handleRequest(req, res);
      if (transport.sessionId) {
        const sid = transport.sessionId;
        sessions.set(sid, { server: sessionServer, transport, lastActivity: Date.now() });
        transport.onclose = () => {
          sessions.delete(sid);
          void sessionServer.close();
        };
        transport.onerror = (err) => console.error("[http-proxy] transport error:", err);
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => nodeServer.listen(opts.port, opts.host, resolve));

  const { port } = nodeServer.address() as { port: number };

  // periodic sweep: close and evict sessions that have been idle too long, so
  // abandoned clients don't accumulate connections/memory on the proxy.
  const idleTimer =
    sessionIdleTimeoutMs > 0
      ? setInterval(() => {
          const cutoff = Date.now() - sessionIdleTimeoutMs;
          for (const [sid, entry] of sessions) {
            if (entry.lastActivity < cutoff) void evictSession(sid);
          }
        }, Math.min(sessionIdleTimeoutMs, 30_000)).unref?.() ?? undefined
      : undefined;

  return {
    server: nodeServer,
    getPort: () => port,
    close: async () => {
      if (idleTimer) clearInterval(idleTimer);
      await Promise.all(
        [...sessions.keys()].map((sid) => evictSession(sid)),
      );
      await onShutdown?.();
      await new Promise<void>((resolve, reject) =>
        nodeServer.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
