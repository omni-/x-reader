import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fileURLToPath } from "node:url";
import { Reader } from "../dist/reader.js";
import { serveHttp } from "../dist/http.js";
import { FixtureBrowser } from "./fixtures.mjs";
import { request } from "node:http";

async function exercise(client) {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      "get_post",
      "get_thread",
      "search_x",
      "get_user_posts",
      "get_status",
      "read_media",
    ].sort(),
  );
  for (const tool of tools)
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
  const args = {
    url: "https://x.com/root/status/100?token=PRIVATE_URL_TOKEN#fragment",
    max_posts: 2,
    max_depth: 2,
  };
  const first = await client.callTool({ name: "get_thread", arguments: args });
  assert.equal(first.isError, undefined);
  const data = first.structuredContent.data;
  assert.equal(data.posts[0].id, "100");
  assert.equal(data.posts[1].author.username, "alice");
  assert.equal(data.posts[1].parent_id, "100");
  assert.ok(
    first.content[0].text.length < 250,
    "dataset must not be duplicated in text output",
  );
  const second = await client.callTool({
    name: "get_thread",
    arguments: { ...args, cursor: data.next_cursor },
  });
  assert.deepEqual(
    second.structuredContent.data.posts.map((p) => p.id),
    ["300", "400"],
  );
  const mediaId = second.structuredContent.data.posts[1].media[0].media_id;
  const media = await client.callTool({
    name: "read_media",
    arguments: { media_id: mediaId },
  });
  assert.equal(media.content[0].type, "image");
  assert.equal(media.content[0].mimeType, "image/png");
  await client.callTool({
    name: "search_x",
    arguments: { query: "from:alice cats", sort: "latest", limit: 5 },
  });
  for (const call of [
    { name: "navigate", arguments: { url: "https://evil.test" } },
    { name: "get_post", arguments: { url: "https://x.com/messages" } },
    { name: "get_status", arguments: { cookie: "FAKE_SECRET_DO_NOT_ACCEPT" } },
    { name: "read_media", arguments: { media_id: "C:/secret.png" } },
  ])
    assert.equal((await client.callTool(call)).isError, true);
  const loggedOut = await client.callTool({
    name: "get_post",
    arguments: { url: "https://x.com/a/status/666" },
  });
  assert.equal(loggedOut.isError, true);
  assert.equal(loggedOut.structuredContent.error.code, "login_required");
}

test("official MCP client exercises stdio schemas, retrieval, continuation and PNG media", async () => {
  const client = new Client({ name: "synthetic-stdio-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./mcp-fixture-server.mjs", import.meta.url))],
    stderr: "pipe",
    env: { ...process.env, X_READER_LOG_FORMAT: "json" },
  });
  let logs = "";
  transport.stderr.on("data", (chunk) => {
    logs += chunk;
  });
  try {
    await client.connect(transport);
    await exercise(client);
  } finally {
    await client.close();
  }
  const events = logs
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const started = events.filter((event) => event.event === "request_started");
  assert.ok(started.length > 0);
  const threadStart = started.find((event) => event.tool === "get_thread");
  assert.equal(threadStart.url, "https://x.com/root/status/100");
  assert.equal(threadStart.max_posts, 2);
  assert.equal(threadStart.max_depth, 2);
  const searchStart = started.find((event) => event.tool === "search_x");
  assert.equal(searchStart.query, "from:alice cats");
  assert.equal(searchStart.sort, "latest");
  assert.equal(searchStart.limit, 5);
  assert.ok(started.some((event) => event.continuation === true));
  assert.doesNotMatch(logs, /PRIVATE_URL_TOKEN|fragment/);
  for (const start of started) {
    assert.ok(
      events.some(
        (event) =>
          event.request_id === start.request_id &&
          ["request_finished", "request_failed"].includes(event.event),
      ),
    );
  }
  assert.doesNotMatch(logs, /FAKE_SECRET|Original claim|Cookie|Authorization/);
});

test("official MCP HTTP client exercises the same stack, Host/Origin guards and clean shutdown", async () => {
  const http = await serveHttp(new Reader(new FixtureBrowser()), 0);
  const client = new Client({ name: "synthetic-http-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(http.url));
  try {
    assert.equal(
      (await fetch(http.url, { headers: { Origin: "https://evil.test" } }))
        .status,
      403,
    );
    const hostileHostStatus = await new Promise((resolve, reject) => {
      const req = request(
        http.url,
        { headers: { Host: "evil.test" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(hostileHostStatus, 403);
    assert.equal((await fetch(http.url.replace("/mcp", "/shell"))).status, 404);
    assert.equal(
      (
        await fetch(http.url, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "ignored",
        })
      ).status,
      415,
    );
    await client.connect(transport);
    await exercise(client);
    await transport.terminateSession();
  } finally {
    await client.close();
    await http.close();
  }
});

test("MCP HTTP accepts many simultaneous sessions and keeps each usable", async () => {
  const http = await serveHttp(new Reader(new FixtureBrowser()), 0);
  const clients = Array.from({ length: 32 }, (_, index) => ({
    client: new Client({ name: `http-session-${index}`, version: "1" }),
    transport: new StreamableHTTPClientTransport(new URL(http.url)),
  }));
  try {
    const connections = await Promise.allSettled(
      clients.map(({ client, transport }) => client.connect(transport)),
    );
    assert.ok(connections.every((result) => result.status === "fulfilled"));
    assert.equal(
      new Set(clients.map(({ transport }) => transport.sessionId)).size,
      32,
    );
    for (const { client } of clients) {
      assert.equal((await client.listTools()).tools.length, 6);
    }
    await Promise.all(
      clients.map(({ transport }) => transport.terminateSession()),
    );
  } finally {
    await Promise.all(clients.map(({ client }) => client.close()));
    await http.close();
  }
});

test("MCP HTTP expires abandoned sessions while retaining recently used sessions", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  const http = await serveHttp(new Reader(new FixtureBrowser()), 0);
  const send = (body, session) =>
    fetch(http.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify(body),
    });
  const initialize = async () => {
    const response = await send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "idle-test", version: "1" },
      },
    });
    assert.equal(response.status, 200);
    await response.json();
    return response.headers.get("mcp-session-id");
  };
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
  try {
    const abandoned = await initialize();
    const active = await initialize();
    t.mock.timers.tick(9 * 60 * 1000);
    const used = await send(list, active);
    assert.equal(used.status, 200);
    await used.json();

    t.mock.timers.tick(2 * 60 * 1000);
    const expired = await send(list, abandoned);
    assert.equal(expired.status, 404);
    assert.match(await expired.text(), /session expired/);
    const retained = await send(list, active);
    assert.equal(retained.status, 200);
    assert.equal((await retained.json()).result.tools.length, 6);
  } finally {
    await http.close();
    t.mock.timers.reset();
  }
});

test("MCP HTTP cancellation stops an active browser request", async () => {
  let entered, closed;
  const opened = new Promise((resolve) => {
    entered = resolve;
  });
  const finished = new Promise((resolve) => {
    closed = resolve;
  });
  const fixture = new FixtureBrowser({
    onPage: () => entered(),
    onClose: () => closed(),
  });
  const http = await serveHttp(new Reader(fixture), 0);
  const client = new Client({ name: "http-cancellation-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(http.url));
  try {
    await client.connect(transport);
    const controller = new AbortController();
    const call = client.callTool(
      {
        name: "get_thread",
        arguments: { url: "https://x.com/root/status/100" },
      },
      undefined,
      { signal: controller.signal },
    );
    const rejection = assert.rejects(call);
    await opened;
    controller.abort();
    await rejection;
    await finished;
  } finally {
    await client.close();
    await http.close();
  }
});
