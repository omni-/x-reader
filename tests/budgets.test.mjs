import test from "node:test";
import assert from "node:assert/strict";
import { FixtureBrowser } from "./fixtures.mjs";
const previous = {
  pages: process.env.X_READER_PAGES,
  scrolls: process.env.X_READER_SCROLLS,
};
process.env.X_READER_PAGES = "1";
process.env.X_READER_SCROLLS = "1";
const { Reader, clearCache } = await import("../dist/reader.js");
for (const [key, value] of [
  ["X_READER_PAGES", previous.pages],
  ["X_READER_SCROLLS", previous.scrolls],
]) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test("page and scroll limits retain their actual stop reason", async () => {
  const reader = new Reader(new FixtureBrowser());
  try {
    const thread = await reader.getThread({
      url: "https://x.com/root/status/100",
      max_posts: 40,
    });
    assert.equal(thread.report.stop_reason, "page_budget");
    assert.equal(thread.report.pages_visited, 1);
    assert.ok(thread.next_cursor);
    const search = await reader.search({ query: "example", limit: 100 });
    assert.equal(search.report.stop_reason, "scroll_budget");
    assert.equal(search.report.scrolls, 1);
  } finally {
    await reader.close();
  }
});

test("local clear-cache invalidates active cursors and media references", async () => {
  const reader = new Reader(new FixtureBrowser());
  const args = { url: "https://x.com/root/status/100", max_posts: 2 };
  try {
    const result = await reader.getThread(args);
    const image = await reader.getPost({
      url: "https://x.com/carol/status/400",
    });
    await clearCache();
    await assert.rejects(
      reader.getThread({ ...args, cursor: result.next_cursor }),
      { code: "cursor_expired" },
    );
    await assert.rejects(reader.readMedia(image.posts[0].media[0].media_id), {
      code: "cursor_expired",
    });
  } finally {
    await reader.close();
  }
});
