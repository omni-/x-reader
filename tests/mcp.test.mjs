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
    url: "https://x.com/root/status/100",
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
  });
  try {
    await client.connect(transport);
    await exercise(client);
  } finally {
    await client.close();
  }
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
