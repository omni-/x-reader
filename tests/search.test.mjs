import test from "node:test";
import assert from "node:assert/strict";
import { Reader } from "../dist/reader.js";
import { combineSearchResults } from "../dist/combine.js";
import { FixtureBrowser, card, wrap } from "./fixtures.mjs";

const queries = [
  "Astra quota",
  '"Astra is great"',
  '"Astra is good"',
  "Astra 3D Codex",
  "  (Astra OR Codex) from:alice -filter:replies since:2026-01-01  ",
];
test("concurrent search queries preserve exact text, operators, ordering and source records when combined", async () => {
  const browser = new FixtureBrowser();
  const reader = new Reader(browser);
  try {
    const inputs = queries.flatMap((query) =>
      ["latest", "top"].map((sort) => ({ query, sort, limit: 100 })),
    );
    const results = await Promise.all(
      inputs.map((input) => reader.search(input)),
    );
    results.forEach((result, i) => {
      assert.deepEqual(result.search, {
        query: inputs[i].query,
        sort: inputs[i].sort,
      });
      assert.equal(result.posts.length, 8);
      assert.deepEqual(result.report.ordering, [
        inputs[i].sort === "latest" ? "Latest" : "Top",
      ]);
      for (const post of result.posts)
        assert.equal(
          new URL(post.observed_on).searchParams.get("q"),
          inputs[i].query,
        );
    });
    const combined = combineSearchResults(results);
    assert.equal(combined.posts.length, 8);
    assert.equal(combined.searches, results);
    assert.equal(combined.matches[0].search_indexes.length, inputs.length);
    assert.deepEqual(combined.posts[0], results[0].posts[0]);
    assert.equal(combined.complete, false);
  } finally {
    await reader.close();
  }
});

test("transient navigation failures retry the unchanged query once; persistent failures stop", async () => {
  for (const persistent of [false, true]) {
    let visits = 0;
    const urls = [];
    const reader = new Reader(
      new FixtureBrowser({
        onPage: async (page) => {
          await page.route("https://x.com/search?**", async (route) => {
            visits++;
            urls.push(route.request().url());
            if (persistent || visits === 1)
              await route.fulfill({ status: 503, body: "Temporary outage" });
            else await route.fallback();
          });
        },
      }),
    );
    try {
      if (persistent)
        await assert.rejects(reader.search({ query: queries[1] }), {
          code: "navigation_error",
        });
      else
        assert.equal(
          (await reader.search({ query: queries[1] })).posts.length,
          8,
        );
      assert.equal(visits, 2);
      assert.equal(urls[0], urls[1]);
    } finally {
      await reader.close();
    }
  }
});

test("empty results, access barriers and malformed extraction remain distinct", async () => {
  const cases = [
    ["empty", null, "empty_results"],
    ["login", wrap("", { auth: false }), "login_required"],
    [
      "rate",
      wrap("", { ui: "<div>Rate limit exceeded</div>" }),
      "rate_limited",
    ],
    [
      "broken",
      wrap('<article data-testid="tweet">Unrecognized post</article>', {
        selected: "Latest",
        timeline: "Timeline: Search timeline",
      }),
      "extraction_error",
    ],
    [
      "wrong",
      wrap(card("123", "author", "Wrong sort"), {
        selected: "Top",
        timeline: "Timeline: Search timeline",
      }),
      "unsupported_sort",
    ],
  ];
  for (const [query, body, code] of cases) {
    let visits = 0;
    const reader = new Reader(
      new FixtureBrowser({
        onPage: async (page) => {
          await page.route("https://x.com/search?**", async (route) => {
            visits++;
            if (body) await route.fulfill({ contentType: "text/html", body });
            else await route.fallback();
          });
        },
      }),
    );
    try {
      if (code === "empty_results") {
        const result = await reader.search({ query });
        assert.deepEqual(result.posts, []);
        assert.equal(result.report.stop_reason, code);
      } else await assert.rejects(reader.search({ query }), { code });
      assert.equal(visits, code === "extraction_error" ? 2 : 1);
    } finally {
      await reader.close();
    }
  }
});

test("article previews preserve title and excerpt separately and declare truncation", async () => {
  const browser = new FixtureBrowser();
  await browser.run(async (page) => {
    const { extractVisible } = await import("../dist/dom.js");
    const preview =
      '<div><div data-testid="article-cover-image"></div><div><div dir="auto">Exact title🚀</div><div dir="auto">First line\nAn excerpt...</div></div></div>';
    await page.setContent(
      wrap(
        card("123", "author", null).replace(
          "</article>",
          preview + "</article>",
        ),
      ),
    );
    const frame = await extractVisible(
      page,
      "https://x.com/search?q=example&f=live",
    );
    assert.equal(frame.posts[0].text, null);
    assert.equal(frame.posts[0].article_preview.title, "Exact title🚀");
    assert.equal(
      frame.posts[0].article_preview.text,
      "First line\nAn excerpt...",
    );
    assert.equal(frame.posts[0].truncated, true);
    assert.deepEqual(frame.posts[0].quoted_posts, []);
  });
});
