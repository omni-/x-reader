import { parseArgs } from "node:util";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { combineSearchResults } from "../dist/combine.js";
import { resultSchema } from "../dist/schema.js";

const { values } = parseArgs({
  options: { phase: { type: "string", default: "all" } },
});
assert.ok(["all", "concurrent", "extra"].includes(values.phase));
let passed = 0;
const client = new Client({ name: "x-reader-search-live", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "stdio"],
  stderr: "pipe",
  env: Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith("X_READER_")),
  ),
});
const searches = [
  "Astra quota",
  '"Astra is great"',
  '"Astra is good"',
  "Astra 3D Codex",
].flatMap((query) =>
  ["latest", "top"].map((sort) => ({ query, sort, limit: 100 })),
);
async function search(args, phase, empty = false) {
  const result = await client.callTool(
    { name: "search_x", arguments: args },
    undefined,
    { timeout: 190000 },
  );
  assert.ok(!result.isError, JSON.stringify(result.structuredContent));
  const data = resultSchema.parse(result.structuredContent.data);
  assert.deepEqual(data.search, { query: args.query, sort: args.sort });
  assert.deepEqual(data.report.ordering, [
    args.sort === "latest" ? "Latest" : "Top",
  ]);
  assert.ok(
    [
      "empty_results",
      "scroll_budget",
      "configured_limit",
      "no_further_visible_content",
    ].includes(data.report.stop_reason),
    data.report.stop_reason,
  );
  if (empty) {
    assert.equal(data.posts.length, 0);
    assert.equal(data.report.stop_reason, "empty_results");
    assert.equal(data.next_cursor, null);
  } else {
    assert.ok(
      data.posts.length > 0,
      `Expected actual retrieval for ${args.query}`,
    );
    for (const post of data.posts) {
      assert.match(post.id, /^\d+$/);
      assert.ok(post.author.username);
      assert.ok(
        post.text ||
          post.media.length ||
          post.quoted_posts.length ||
          post.article_preview?.title,
        `Post ${post.id} needs text, media, quote or article preview evidence`,
      );
      const observed = new URL(post.observed_on);
      assert.equal(observed.searchParams.get("q"), args.query);
      assert.equal(
        observed.searchParams.get("f"),
        args.sort === "latest" ? "live" : null,
      );
    }
    assert.equal(
      new Set(data.posts.map((post) => post.id)).size,
      data.posts.length,
    );
  }
  console.log(
    JSON.stringify({
      phase,
      ...args,
      count: data.posts.length,
      stop: data.report.stop_reason,
      first_id: data.posts[0]?.id,
    }),
  );
  passed++;
  return data;
}
try {
  await client.connect(transport);
  transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  if (values.phase === "all")
    for (const args of searches) await search(args, "sequential");
  let combined;
  if (values.phase !== "extra") {
    const concurrent = await Promise.allSettled(
      searches.map((args) => search(args, "concurrent")),
    );
    for (const item of concurrent)
      if (item.status === "rejected") throw item.reason;
    const results = concurrent.map((item) => item.value);
    combined = combineSearchResults(results);
    assert.equal(
      combined.posts.length,
      new Set(results.flatMap((result) => result.posts.map((post) => post.id)))
        .size,
    );
  }
  if (values.phase !== "concurrent") {
    await search(
      {
        query: "Astra (Codex OR quota) -filter:replies",
        sort: "latest",
        limit: 20,
      },
      "operators",
    );
    const absent = `"xreader_no_result_${crypto.randomUUID().replaceAll("-", "")}"`;
    for (const sort of ["latest", "top"])
      await search({ query: absent, sort, limit: 5 }, "empty", true);
  }
  console.log(
    JSON.stringify({
      phase: values.phase,
      passed,
      unique_concurrent_posts: combined?.posts.length,
      complete: false,
    }),
  );
} finally {
  await client.close();
}
