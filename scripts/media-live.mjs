import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Reader } from "../dist/reader.js";
import { serveHttp } from "../dist/http.js";

const { values } = parseArgs({
  options: {
    transport: { type: "string", default: "stdio" },
    endpoint: { type: "string" },
    article: {
      type: "string",
      default: "https://x.com/lon/status/2101034933284417614",
    },
    image: {
      type: "string",
      default: "https://x.com/nasa/status/2100953558015250850",
    },
    video: {
      type: "string",
      default: "https://x.com/NuclearStorm235/status/2101309942108188882",
    },
    output: { type: "string", default: ".local/media-live" },
  },
});
assert.ok(["stdio", "http"].includes(values.transport));
const local =
  values.transport === "http" && !values.endpoint
    ? await serveHttp(new Reader(), 0)
    : null;
const client = new Client({ name: "media-live-verification", version: "1" });
const transport =
  values.transport === "http"
    ? new StreamableHTTPClientTransport(new URL(values.endpoint ?? local.url))
    : new StdioClientTransport({
        command: process.execPath,
        args: [
          fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
          "stdio",
        ],
        stderr: "inherit",
        env: { ...process.env },
      });
const directory = resolve(values.output, values.transport);
const evidence = [];
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 110000,
  });
  assert.ok(!result.isError, JSON.stringify(result.structuredContent?.error));
  return result;
}
async function save(label, result, fallback) {
  const data = result.structuredContent.data;
  const block = result.content[data.content_index];
  assert.equal(block.type, "image");
  assert.equal(block.mimeType, "image/png");
  if (fallback)
    assert.equal(data.data_url, `data:image/png;base64,${block.data}`);
  else assert.equal(data.data_url, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 12 * 1024 * 1024);
  const bytes = Buffer.from(
    fallback ? data.data_url.split(",")[1] : block.data,
    "base64",
  );
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const path = resolve(directory, `${label}.png`);
  await writeFile(path, bytes);
  const { data_url: ignored, ...metadata } = data;
  const record = { label, bytes: bytes.length, path, metadata };
  evidence.push(record);
  console.log(JSON.stringify(record));
}
try {
  await mkdir(directory, { recursive: true });
  await client.connect(transport);
  for (const [label, url] of [
    ["article", values.article],
    ["ordinary", values.image],
  ]) {
    const post = (await call("get_post", { url })).structuredContent.data
      .posts[0];
    if (label === "article") {
      assert.ok(post.article.text.length > 16000);
      assert.equal(post.article.truncated, false);
      const thread = (
        await call("get_thread", { url, max_posts: 1, max_depth: 0 })
      ).structuredContent.data.posts[0];
      assert.equal(thread.article.text, post.article.text);
      assert.deepEqual(thread.article.blocks, post.article.blocks);
      console.log(
        JSON.stringify({
          label: "Article unchanged",
          characters: post.article.text.length,
          tables: post.article.blocks.filter((b) => b.type === "table").length,
        }),
      );
    }
    const media =
      label === "article"
        ? post.article.media[1]
        : post.media.find((m) => m.type === "image");
    for (const fallback of [false, true])
      await save(
        `${label}-${fallback ? "compat" : "normal"}`,
        await call("read_media", {
          media_id: media.media_id,
          structured_fallback: fallback,
        }),
        fallback,
      );
  }
  const post = (await call("get_post", { url: values.video })).structuredContent
    .data.posts[0];
  const video = post.media.find((m) => m.type === "video");
  assert.ok(video?.media_id, "No discovered video ID");
  const sheet = await call("read_video", {
    media_id: video.media_id,
    structured_fallback: true,
  });
  assert.equal(sheet.structuredContent.data.frames.length, 8);
  await save("video-contact-compat", sheet, true);
  const frame = sheet.structuredContent.data.frames[3];
  const individual = await call("read_media", {
    media_id: frame.media_id,
    structured_fallback: true,
  });
  assert.ok(
    Math.abs(
      individual.structuredContent.data.timestamp_seconds -
        frame.timestamp_seconds,
    ) < 1e-9,
    "Frame ID must retrieve the same decoded frame timestamp",
  );
  await save("video-frame-compat", individual, true);
  const selected = await call("read_video", {
    media_id: video.media_id,
    timestamps: [frame.timestamp_seconds],
    frame_count: 1,
    transcribe: true,
  });
  assert.ok(
    Math.abs(
      selected.structuredContent.data.frames[0].timestamp_seconds -
        frame.timestamp_seconds,
    ) < 1e-9,
    "An actual timestamp must round-trip without slipping to the next frame",
  );
  await save("video-timestamp-normal", selected, false);
  const text = (await call("get_post", { url: "https://x.com/jack/status/20" }))
    .structuredContent.data.posts[0];
  assert.equal(text.text, "just setting up my twttr");
  assert.equal(text.article, undefined);
  assert.equal(text.media.length, 0);
  await writeFile(
    resolve(directory, "evidence.json"),
    JSON.stringify(
      {
        transport: values.transport,
        evidence,
        model_vision:
          "UNVERIFIED by this script; submit received pixels through the actual client's documented image-input interface and identify pixel-only details.",
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
  await local?.close();
}
