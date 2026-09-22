import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BrowserSession, navigate } from "../dist/browser.js";
import { postUrl } from "../dist/validation.js";

const { values } = parseArgs({
  options: {
    article: {
      type: "string",
      default: "https://x.com/lon/status/2101034933284417614",
    },
    "text-image": { type: "string" },
    image: { type: "string" },
    text: { type: "string" },
    endpoint: { type: "string" },
    output: { type: "string" },
  },
});
assert.ok(
  values["text-image"] && values.image && values.text,
  "Supply --text-image, --image and --text public post URLs; --output optionally saves received PNGs for visual inspection.",
);
const browser = new BrowserSession();
const client = new Client({ name: "rich-content-live-test", version: "1" });
const transport = values.endpoint
  ? new StreamableHTTPClientTransport(new URL(values.endpoint))
  : new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
        "stdio",
      ],
      stderr: "inherit",
    });
const checks = [];
const passed = (name, detail) => {
  checks.push(name);
  console.log(JSON.stringify({ passed: name, ...detail }));
};
async function call(name, args) {
  const response = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 100000,
  });
  assert.ok(
    !response.isError,
    `${name}: ${JSON.stringify(response.structuredContent?.error ?? response.content)}`,
  );
  return response;
}
const normalize = (text) => text.replace(/\s+/g, " ").trim();
try {
  await client.connect(transport);
  const response = await call("get_post", { url: values.article });
  const post = response.structuredContent.data.posts[0];
  assert.equal(post.id, postUrl(values.article).id);
  assert.ok(post.article?.text?.length > 16000);
  assert.equal(post.article.source, "rendered_dom");
  assert.equal(
    post.article.truncated,
    false,
    post.article.limitations.join(" "),
  );
  assert.equal(
    response.content.some((item) => item.type === "image"),
    false,
  );
  // Independently compare every rendered prose block and table cell, not the extractor's helpers.
  const expected = await browser.run(async (page, signal) => {
    await navigate(page, values.article, signal);
    const body = page.locator('[data-testid="longformRichTextComponent"]');
    await body.waitFor();
    const sections = body.locator('section[data-block="true"]');
    for (let index = 0; index < (await sections.count()); index++) {
      const section = sections.nth(index);
      if (
        await section.evaluate(
          (e) =>
            !e.textContent?.trim() &&
            !e.querySelector('img,[role="separator"]'),
        )
      ) {
        await section.scrollIntoViewIfNeeded();
        await section
          .locator("table,math,img,a[href]")
          .first()
          .waitFor({ state: "attached", timeout: 2000 });
      }
    }
    return body.evaluate((root) => ({
      prose: [...root.querySelectorAll('[data-block="true"]')]
        .filter((e) => e.tagName !== "SECTION")
        .map((e) => e.innerText)
        .filter(Boolean),
      cells: [...root.querySelectorAll("td,th")].map((e) => e.innerText),
      tables: root.querySelectorAll("table").length,
      links: [...root.querySelectorAll("a[href]")].map((e) => e.href),
    }));
  });
  for (const text of [...expected.prose, ...expected.cells])
    assert.ok(
      normalize(post.article.text).includes(normalize(text)),
      `Missing rendered content: ${text.slice(0, 100)}`,
    );
  assert.equal(
    post.article.blocks.filter((block) => block.type === "table").length,
    expected.tables,
  );
  for (const link of expected.links)
    assert.ok(post.article.links.some((item) => item.url === link));
  passed("Article matches rendered prose, tables and links", {
    url: post.url,
    title: post.article.title,
    characters: post.article.text.length,
    blocks: post.article.blocks.length,
    tables: expected.tables,
    links: post.article.links.length,
    media: post.article.media.length,
    post_text: post.text,
  });

  const thread = (
    await call("get_thread", {
      url: values.article,
      max_posts: 1,
      max_depth: 0,
    })
  ).structuredContent.data.posts[0];
  assert.equal(thread.article.text, post.article.text);
  assert.deepEqual(thread.article.blocks, post.article.blocks);
  assert.deepEqual(thread.article.links, post.article.links);
  passed("Thread preserves Article", { url: thread.url });
  const figure = await call("read_media", {
    media_id: thread.article.media.at(-1).media_id,
  });
  assert.equal(figure.content[0].type, "image");
  passed("Article figure remains readable on demand", {
    source: figure.structuredContent.data.source,
    limitations: figure.structuredContent.data.limitations,
  });

  for (const [label, url] of [
    ["text-heavy", values["text-image"]],
    ["ordinary", values.image],
  ]) {
    const result = await call("get_post", { url });
    const data = result.structuredContent.data;
    const provided = data.media_content?.find(
      (item) => item.status === "provided_to_client",
    );
    assert.ok(provided, JSON.stringify(data.media_content));
    const image = result.content[provided.content_index];
    assert.equal(image.type, "image");
    assert.equal(provided.server_analysis, false);
    assert.equal(provided.source, "cdn_image");
    const png = Buffer.from(image.data, "base64");
    assert.ok(png.length > 100);
    let path;
    if (values.output) {
      await mkdir(resolve(values.output), { recursive: true });
      path = resolve(values.output, `${label}.png`);
      await writeFile(path, png);
    }
    const conversation = await call("get_thread", {
      url,
      max_posts: 1,
      max_depth: 0,
    });
    assert.equal(
      conversation.structuredContent.data.posts[0].text,
      data.posts[0].text,
    );
    assert.ok(
      conversation.structuredContent.data.media_content.some(
        (item) => item.status === "provided_to_client",
      ),
    );
    passed(`${label} image delivered through MCP`, {
      url,
      width: provided.width,
      height: provided.height,
      bytes: png.length,
      path,
      limitations: provided.limitations,
    });
  }
  const text = (await call("get_post", { url: values.text })).structuredContent
    .data.posts[0];
  assert.ok(text.text);
  assert.equal(text.article, undefined);
  assert.equal(text.media.length, 0);
  passed("Normal text post", { url: text.url, text: text.text });
  console.log(
    JSON.stringify({
      passed: checks.length,
      source: "live X through the official MCP client",
      image_interpretation:
        "calling model; visually inspect the received PNGs to verify transcription/description quality",
    }),
  );
} finally {
  await browser.close();
  await client.close();
}
