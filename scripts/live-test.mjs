import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BrowserSession, navigate } from "../dist/browser.js";
import { postUrl } from "../dist/validation.js";

const { values } = parseArgs({
  options: {
    thread: { type: "string" },
    query: { type: "string" },
    nested: { type: "string" },
    quote: { type: "string" },
    image: { type: "string" },
  },
});
if (!values.thread || !values.query) {
  console.error(
    'Usage: npm run test:live -- --thread "https://x.com/handle/status/id" --query "search terms" [--nested "reply URL"] [--quote "quote URL"] [--image "image post URL"]',
  );
  process.exit(2);
}
const root = fileURLToPath(new URL("../", import.meta.url));
const client = new Client({
  name: "x-reader-live-verification",
  version: "0.1.0",
});
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => key.startsWith("X_READER_") && value !== undefined,
  ),
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "stdio"],
  cwd: root,
  stderr: "pipe",
  env: environment,
});
const browser = new BrowserSession();
const checks = [];
const skipped = [];
const warnings = [];
const passed = (name, detail) => {
  checks.push({ name, passed: true, detail });
  console.log(JSON.stringify(checks.at(-1)));
};
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 100000,
  });
  assert.equal(
    result.isError,
    undefined,
    `${name} failed: ${result.structuredContent?.error?.code ?? "protocol_error"}`,
  );
  assert.ok(result.structuredContent?.data, `${name} omitted structured data`);
  const data = result.structuredContent.data;
  if (
    data.report &&
    [
      "deadline",
      "cancelled",
      "login_required",
      "challenge",
      "rate_limited",
      "account_restricted",
      "protected_content",
      "navigation_error",
      "unexpected_redirect",
      "extraction_error",
    ].includes(data.report.stop_reason)
  ) {
    const warning = {
      tool: name,
      stop: data.report.stop_reason,
      affected_branches: data.report.unexpanded_branches.filter(
        (branch) => branch.reason === data.report.stop_reason,
      ),
    };
    warnings.push(warning);
    console.log(JSON.stringify({ warning }));
  }
  return data;
}

// Separate projection of the rendered focal article; does not call the production extractor.
async function compareInBrowser(post) {
  return browser.run(async (page, signal) => {
    await navigate(page, post.url, signal);
    await page
      .locator(
        `article[data-testid="tweet"] a[href$="/status/${post.id}"] time`,
      )
      .first()
      .waitFor({ timeout: 15000 });
    const actual = await page.evaluate((id) => {
      const article = [
        ...document.querySelectorAll(
          '[data-testid="primaryColumn"] article[data-testid="tweet"]',
        ),
      ].find((node) =>
        [...node.querySelectorAll("a:has(time)")].some((anchor) =>
          anchor.getAttribute("href")?.endsWith(`/status/${id}`),
        ),
      );
      if (!article) return null;
      const header = article.querySelector('[data-testid="User-Name"]');
      const handle = [...(header?.querySelectorAll("span") ?? [])]
        .map((s) => s.textContent)
        .find((s) => /^@[A-Za-z0-9_]+$/.test(s ?? ""));
      const node = article
        .querySelector('[data-testid="tweetText"]')
        ?.cloneNode(true);
      node
        ?.querySelectorAll("img[alt]")
        .forEach((image) =>
          image.replaceWith(document.createTextNode(image.getAttribute("alt"))),
        );
      node
        ?.querySelectorAll("br")
        .forEach((br) => br.replaceWith(document.createTextNode("\n")));
      const links = [
        ...article.querySelectorAll(
          '[data-testid="replyingTo"] a[href], a[aria-label^="Replying to"]',
        ),
      ]
        .filter((a) => !a.closest('[data-testid="tweetText"]'))
        .map((a) => a.getAttribute("href"));
      const permalink = [...article.querySelectorAll("a:has(time)")]
        .find((a) => a.getAttribute("href")?.endsWith(`/status/${id}`))
        ?.getAttribute("href");
      return {
        username: handle?.slice(1),
        text: node?.textContent ?? null,
        permalink,
        parentLinks: links,
      };
    }, post.id);
    assert.ok(actual, `Focal ${post.id} missing from browser`);
    assert.equal(
      actual.username?.toLowerCase(),
      post.author.username?.toLowerCase(),
      `Author mismatch at ${post.id}`,
    );
    assert.equal(
      postUrl(`https://x.com${actual.permalink}`).url,
      post.url,
      `Permalink mismatch at ${post.id}`,
    );
    if (post.truncated)
      assert.ok(
        actual.text?.startsWith(post.text?.replace(/…$/, "") ?? ""),
        `Truncated text mismatch at ${post.id}`,
      );
    else assert.equal(actual.text, post.text, `Text mismatch at ${post.id}`);
    if (post.parent_id)
      assert.ok(
        actual.parentLinks.some((href) =>
          href?.includes(`/status/${post.parent_id}`),
        ),
        `Unsupported exact parent at ${post.id}`,
      );
    else assert.equal(post.parent_evidence, null);
    return {
      id: post.id,
      url: post.url,
      author: post.author.username,
      text_matched: true,
      parent: post.parent_id ?? "unknown; no relationship invented",
    };
  });
}

try {
  await client.connect(transport);
  const status = await call("get_status");
  assert.equal(status.ready, true, `${status.state}: ${status.action}`);
  passed("authenticated MCP session", status.state);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 6);
  const args = { url: values.thread, max_posts: 40, max_depth: 2 };
  const thread = await call("get_thread", args);
  assert.equal(thread.report.focal_id, postUrl(values.thread).id);
  assert.equal(thread.posts[0]?.id, thread.report.focal_id);
  assert.ok(
    new Set(thread.posts.map((p) => p.author.username)).size >= 3,
    "Use a public thread with at least three participants",
  );
  passed("multi-participant root conversation", {
    returned: thread.posts.length,
    collected: thread.report.total_collected,
    depth: thread.report.depth_reached,
    stop: thread.report.stop_reason,
    ordering: thread.report.ordering,
  });
  const sample = [];
  const authors = new Set();
  for (const post of thread.posts)
    if (post.text && !authors.has(post.author.username) && sample.length < 3) {
      sample.push(post);
      authors.add(post.author.username);
    }
  for (const post of sample)
    passed("independent browser comparison", await compareInBrowser(post));
  if (thread.next_cursor) {
    const next = await call("get_thread", {
      ...args,
      cursor: thread.next_cursor,
    });
    assert.equal(
      next.posts.some((p) => thread.posts.some((q) => q.id === p.id)),
      false,
    );
    passed("live cursor continuation", {
      additional_posts: next.posts.length,
      stop: next.report.stop_reason,
      depth: next.report.depth_reached,
    });
  } else {
    const check = {
      name: "live cursor continuation",
      reason:
        "No retained traversal remained; covered in deterministic tests only",
    };
    skipped.push(check);
    console.log(JSON.stringify({ skipped: check }));
  }
  const nestedUrl =
    values.nested ??
    thread.posts.find(
      (p) => p.id !== thread.report.focal_id && p.relation === "conversation",
    )?.url;
  assert.ok(nestedUrl, "No reply URL was available");
  const nested = await call("get_thread", {
    url: nestedUrl,
    max_posts: 12,
    max_depth: 2,
  });
  assert.equal(nested.report.focal_id, postUrl(nestedUrl).id);
  assert.ok(
    nested.report.ancestor_context_ids.length > 0,
    "This reply did not expose ancestor context",
  );
  const focal = nested.posts.find((p) => p.id === nested.report.focal_id);
  passed("reply link preserves focal and ancestors", {
    ...(await compareInBrowser(focal)),
    ancestors: nested.report.ancestor_context_ids,
    stop: nested.report.stop_reason,
  });
  for (const sort of ["latest", "top"]) {
    const search = await call("search_x", {
      query: values.query,
      limit: 3,
      sort,
    });
    assert.ok(
      search.report.ordering.some((label) => label.toLowerCase() === sort),
    );
    passed(`live ${sort} search`, {
      posts: search.posts.length,
      stop: search.report.stop_reason,
      ordering: search.report.ordering,
    });
  }
  const user = await call("get_user_posts", {
    username: thread.posts[0].author.username,
    limit: 3,
  });
  assert.ok(user.posts.length > 0);
  passed("live public user posts", {
    posts: user.posts.length,
    ordering: user.report.ordering,
  });
  if (values.quote) {
    const quote = await call("get_post", { url: values.quote });
    assert.ok(quote.posts[0].quoted_posts.length > 0);
    assert.ok(
      !quote.posts[0].text?.includes(quote.posts[0].quoted_posts[0].text),
    );
    passed("live quote separation", {
      id: quote.posts[0].id,
      quoted_ids: quote.posts[0].quoted_posts.map((q) => q.id),
    });
  }
  if (values.image) {
    const post = await call("get_post", { url: values.image });
    const id = post.posts[0].media.find(
      (media) => media.type === "image",
    )?.media_id;
    assert.ok(id);
    const media = await client.callTool(
      { name: "read_media", arguments: { media_id: id } },
      undefined,
      { timeout: 100000 },
    );
    assert.equal(media.isError, undefined);
    const pixels = media.content.find((item) => item.type === "image");
    assert.equal(pixels?.mimeType, "image/png");
    assert.ok(Buffer.from(pixels.data, "base64").length > 100);
    passed("live MCP image response", {
      post: post.posts[0].id,
      bytes: Buffer.from(pixels.data, "base64").length,
    });
  }
  console.log(
    JSON.stringify({
      passed: checks.length,
      failed: 0,
      skipped,
      warnings,
      source:
        "authenticated live X via official MCP client; rendered browser comparisons",
      chatgpt_tunnel: "not tested by this command",
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      passed: checks.length,
      failed: 1,
      skipped,
      warnings,
      message:
        error instanceof Error ? error.message : "Live verification failed",
    }),
  );
  process.exitCode = 1;
} finally {
  await browser.close();
  await client.close();
}
