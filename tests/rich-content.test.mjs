import test from "node:test";
import assert from "node:assert/strict";
import { Reader } from "../dist/reader.js";
import { extractVisible } from "../dist/dom.js";
import { resultSchema } from "../dist/schema.js";
import { FixtureBrowser, articleCard, card, wrap } from "./fixtures.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serveHttp } from "../dist/http.js";

const repro = "https://x.com/lon/status/2101034933284417614";

test("repro Article layout preserves the full rendered body, structure, links and seven images", async () => {
  const reader = new Reader(new FixtureBrowser());
  try {
    const result = await reader.getPost({ url: repro });
    resultSchema.parse(result);
    const post = result.posts[0];
    assert.equal(post.text, null);
    assert.equal(post.media.length, 0);
    assert.equal(post.quoted_posts.length, 0);
    assert.equal(post.article.title, "The Inference Gap");
    assert.deepEqual(post.article.author, {
      username: "Lon",
      display_name: "Lon Lundgren",
    });
    assert.equal(post.article.source, "rendered_dom");
    assert.equal(post.article.truncated, false);
    assert.ok(post.article.text.length > 16000);
    assert.match(post.article.text, /^Access to frontier models/);
    assert.match(post.article.text, /First line\nsecond line 🚀/);
    assert.match(post.article.text, /Paragraph 90\./);
    assert.match(post.article.text, /The final paragraph is present\.$/);
    assert.doesNotMatch(
      post.article.text,
      /Upgrade to Premium|16 replies|Image/,
    );
    assert.deepEqual(
      post.article.links.map((link) => link.url),
      ["https://example.org/source", "https://x.com/writer/status/123"],
    );
    assert.deepEqual(post.evidence_links, []);
    assert.ok(
      post.article.blocks.some(
        (block) => block.type === "heading" && block.level === 1,
      ),
    );
    assert.ok(
      post.article.blocks.some(
        (block) => block.type === "list_item" && block.ordered,
      ),
    );
    for (const type of ["blockquote", "code", "separator", "media"])
      assert.ok(post.article.blocks.some((block) => block.type === type));
    assert.equal(post.article.media.length, 7);
    assert.ok(post.article.media.every((media) => media.media_id));
    assert.deepEqual(
      post.article.blocks
        .filter((block) => block.type === "media")
        .map((block) => block.media_indexes),
      [[0], [1], [2], [3], [4], [5], [6]],
    );
    const image = await reader.readMedia(post.article.media[6].media_id);
    assert.equal(image.mimeType, "image/png");
  } finally {
    await reader.close();
  }
});

test("get_thread preserves the same Article as get_post", async () => {
  const reader = new Reader(new FixtureBrowser());
  try {
    const post = (await reader.getPost({ url: repro })).posts[0];
    const thread = await reader.getThread({
      url: repro,
      max_posts: 1,
      max_depth: 0,
    });
    const focal = thread.posts[0];
    assert.equal(focal.id, post.id);
    assert.equal(focal.text, null);
    const withoutIds = (article) => ({
      ...article,
      media: article.media.map((media) => ({ ...media, media_id: null })),
    });
    assert.deepEqual(withoutIds(focal.article), withoutIds(post.article));
    assert.ok(focal.article.media.every((media) => media.media_id));
  } finally {
    await reader.close();
  }
});

test("Article tables and reference links are hydrated from the DOM before extraction", async () => {
  const table =
    '<table><tr><th>Measure</th><th>Value</th></tr><tr><td>Turns</td><td>7,853</td></tr></table><a href="https://example.org/method">Method</a>';
  const html = articleCard().replace(
    '<h2 data-block="true">Conclusion</h2>',
    '<section data-block="true" id="lazy-article-table" style="min-height:30px"></section><h2 data-block="true">Conclusion</h2>',
  );
  const browser = new FixtureBrowser({
    onPage: (page) =>
      page.route(repro, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: wrap(html, {
            script: `const observer = new IntersectionObserver(entries => { for(const entry of entries) if(entry.isIntersecting) { entry.target.innerHTML=${JSON.stringify(table)}; observer.disconnect(); } }); observer.observe(document.getElementById('lazy-article-table'));`,
          }),
        }),
      ),
  });
  const reader = new Reader(browser);
  try {
    const post = (await reader.getPost({ url: repro })).posts[0];
    assert.equal(post.article.truncated, false);
    assert.match(post.article.text, /Measure\tValue\nTurns\t7,853/);
    assert.deepEqual(
      post.article.blocks.find((block) => block.type === "table").rows,
      [
        ["Measure", "Value"],
        ["Turns", "7,853"],
      ],
    );
    assert.ok(
      post.article.links.some(
        (link) => link.url === "https://example.org/method",
      ),
    );
  } finally {
    await reader.close();
  }
});

test("unrendered and oversized Articles disclose missing content without OCR", async () => {
  const browser = new FixtureBrowser();
  await browser.run(async (page) => {
    await page.setContent(
      wrap(
        articleCard().replace(
          'data-testid="longformRichTextComponent"',
          'data-testid="longformRichTextComponent" hidden',
        ),
      ),
    );
    // A missing body differs from an Article with no post text.
    await page
      .locator('[data-testid="twitterArticleRichTextView"]')
      .evaluate((e) => e.remove());
    let post = (await extractVisible(page, repro)).posts[0];
    assert.equal(post.article.text, null);
    assert.equal(post.article.truncated, true);
    assert.match(post.article.limitations.join(" "), /body has not rendered/);

    await page.setContent(wrap(articleCard()));
    await page
      .locator('[data-testid="longformRichTextComponent"]')
      .evaluate((e) => {
        e.innerHTML = '<p data-block="true">' + "x".repeat(60001) + "</p>";
      });
    post = (await extractVisible(page, repro)).posts[0];
    assert.equal(post.article.text.length, 60000);
    assert.equal(post.article.truncated, true);
    assert.match(post.article.limitations.join(" "), /budget/);
  });
});

test("normal text posts keep their text and have no Article field", async () => {
  const browser = new FixtureBrowser();
  await browser.run(async (page) => {
    await page.setContent(
      wrap(
        card("123", "author", "Ordinary text\nSecond line", {
          emoji: true,
          link: true,
        }),
      ),
    );
    const post = (await extractVisible(page, "https://x.com/author/status/123"))
      .posts[0];
    assert.equal(post.text, "Ordinary text\nSecond line🚀 evidence");
    assert.equal(post.article, undefined);
    assert.deepEqual(post.media, []);
  });
});

test("MCP delivers readable text-heavy and ordinary images, preserves source text, and discloses failures and budgets", async () => {
  const http = await serveHttp(new Reader(new FixtureBrowser()), 0);
  const client = new Client({ name: "rich-content-test", version: "1" });
  const call = (name, args) => client.callTool({ name, arguments: args });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));
    const article = await call("get_post", { url: repro });
    assert.equal(article.isError, undefined);
    assert.ok(
      article.structuredContent.data.posts[0].article.text.length > 16000,
    );
    assert.equal(
      article.content.some((item) => item.type === "image"),
      false,
      "DOM Article text must not be sent through image reading",
    );

    for (const [url, width, height, text] of [
      ["https://x.com/text_image/status/910", 800, 1100, "Workshop handout"],
      ["https://x.com/scene/status/920", 640, 480, null],
    ]) {
      const response = await call("get_post", { url });
      assert.equal(response.isError, undefined);
      const data = response.structuredContent.data;
      resultSchema.parse(data);
      assert.equal(data.posts[0].text, text);
      assert.equal(data.posts[0].article, undefined);
      const supplied = data.media_content[0];
      assert.equal(supplied.status, "provided_to_client");
      assert.equal(supplied.server_analysis, false);
      assert.equal(supplied.source, "cdn_image");
      assert.equal(supplied.media_id, data.posts[0].media[0].media_id);
      assert.deepEqual([supplied.width, supplied.height], [width, height]);
      const image = response.content[supplied.content_index];
      assert.equal(image.type, "image");
      const png = Buffer.from(image.data, "base64");
      assert.deepEqual(
        [png.readUInt32BE(16), png.readUInt32BE(20)],
        [width, height],
        "the complete image is supplied, not the 96x72 timeline crop",
      );
      const instructions = response.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join(" ");
      assert.match(instructions, /transcribe.*reading order/);
      assert.match(instructions, /ordinary image.*concise description/);
      assert.match(instructions, /separate from post\/Article text/);

      const standalone = await call("read_media", {
        media_id: supplied.media_id,
      });
      assert.equal(standalone.structuredContent.data.source, "cdn_image");
      assert.equal(standalone.structuredContent.data.server_analysis, false);
      assert.equal(standalone.content[0].type, "image");
      const thread = await call("get_thread", {
        url,
        max_posts: 1,
        max_depth: 0,
      });
      assert.equal(
        thread.structuredContent.data.media_content[0].status,
        "provided_to_client",
      );
      assert.equal(thread.structuredContent.data.posts[0].text, text);
    }

    const ordinary = await call("get_post", {
      url: "https://x.com/root/status/100",
    });
    assert.equal(ordinary.structuredContent.data.posts[0].article, undefined);
    assert.equal(ordinary.structuredContent.data.media_content, undefined);
    assert.equal(ordinary.content.length, 1);

    const broken = await call("get_post", {
      url: "https://x.com/broken/status/930",
    });
    assert.equal(broken.isError, undefined);
    assert.equal(
      broken.structuredContent.data.posts[0].text,
      "The source text remains available",
    );
    assert.equal(
      broken.structuredContent.data.media_content[0].status,
      "unavailable",
    );
    assert.match(
      broken.structuredContent.data.media_content[0].limitations.join(" "),
      /not read/,
    );

    const bounded = await call("get_thread", {
      url: "https://x.com/scene/status/940",
      max_posts: 5,
      max_depth: 1,
    });
    assert.equal(
      bounded.content.filter((item) => item.type === "image").length,
      4,
    );
    assert.equal(
      bounded.structuredContent.data.media_content[4].status,
      "deferred",
    );
  } finally {
    await client.close();
    await http.close();
  }
});
