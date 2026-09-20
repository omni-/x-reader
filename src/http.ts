import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  isInitializeRequest,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./mcp.js";
import { Reader } from "./reader.js";
import { config } from "./config.js";
import { logFailure, ReaderError } from "./errors.js";

export function validHttpBoundary(
  request: Pick<IncomingMessage, "headers" | "socket">,
  port: number,
): boolean {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(request.headers.host ?? "")) return false;
  const origin = request.headers.origin;
  if (origin && !hosts.map((host) => `http://${host}`).includes(origin))
    return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  return ["127.0.0.1", "::ffff:127.0.0.1", "::1"].includes(
    request.socket.remoteAddress ?? "",
  );
}

export async function serveHttp(reader: Reader, port = config.port) {
  type Connection = {
    mcp: ReturnType<typeof createMcpServer>;
    transport: StreamableHTTPServerTransport;
    signals: Map<RequestId, AbortController>;
    touched: number;
  };
  const sessions = new Map<string, Connection>();
  let boundPort = port;
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (!validHttpBoundary(request, boundPort)) {
      response.writeHead(403).end("Forbidden host or origin");
      return;
    }
    if (request.url !== "/mcp") {
      response.writeHead(404).end("Not found");
      return;
    }
    if (!["POST", "GET", "DELETE"].includes(request.method ?? "")) {
      response.writeHead(405, { Allow: "POST, GET, DELETE" }).end();
      return;
    }
    try {
      let body: unknown;
      if (request.method === "POST") {
        if (
          !/^application\/json(?:;|$)/i.test(
            request.headers["content-type"] ?? "",
          )
        ) {
          response.writeHead(415).end("Expected application/json");
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 32768) {
            response.writeHead(413).end("Request too large");
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          response.writeHead(400).end("Invalid JSON");
          return;
        }
      }
      const id = request.headers["mcp-session-id"];
      let connection = typeof id === "string" ? sessions.get(id) : undefined;
      if (!connection && id) {
        response.writeHead(404).end("MCP session expired; initialize again");
        return;
      }
      if (
        !connection &&
        request.method === "POST" &&
        isInitializeRequest(body)
      ) {
        if (sessions.size >= 8) {
          response.writeHead(503).end("Too many local MCP sessions");
          return;
        }
        const signals = new Map<RequestId, AbortController>();
        const mcp = createMcpServer(reader, signals);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          onsessioninitialized: (sessionId) => {
            sessions.set(sessionId, connection!);
          },
        });
        connection = { mcp, transport, signals, touched: Date.now() };
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await mcp.connect(transport);
      }
      if (!connection) {
        response.writeHead(400).end("Initialize an MCP session first");
        return;
      }
      connection.touched = Date.now();
      const requestId = (body as { id?: RequestId } | undefined)?.id;
      const controller = new AbortController();
      const selected = connection;
      if (requestId !== undefined) selected.signals.set(requestId, controller);
      response.once("close", () => {
        if (!response.writableEnded) controller.abort();
        if (requestId !== undefined) selected.signals.delete(requestId);
      });
      await connection.transport.handleRequest(request, response, body);
    } catch (error) {
      logFailure(error);
      if (!response.headersSent)
        response.writeHead(500).end("Local MCP transport failed");
      else response.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const timer = setInterval(() => {
    for (const [id, session] of sessions) {
      if (
        !session.signals.size &&
        Date.now() - session.touched > config.cacheMs
      ) {
        sessions.delete(id);
        void session.mcp.close();
      }
    }
  }, 30000);
  timer.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", () =>
      reject(
        new ReaderError(
          "http_bind_failed",
          "Cannot listen on loopback. Another server may already use this port.",
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address && typeof address !== "string") boundPort = address.port;
  return {
    url: `http://127.0.0.1:${boundPort}/mcp`,
    async close(): Promise<void> {
      clearInterval(timer);
      for (const session of sessions.values()) {
        for (const controller of session.signals.values()) controller.abort();
        await session.mcp.close();
      }
      sessions.clear();
      await reader.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
