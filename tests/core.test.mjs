import test from "node:test";
import assert from "node:assert/strict";
import {
  postUrl,
  username,
  searchInput,
  threadInput,
  allowedImage,
  safeEvidenceUrl,
} from "../dist/validation.js";
import { ExpiringStore } from "../dist/cache.js";
import { publicError } from "../dist/errors.js";
import { navigationAllowed } from "../dist/browser.js";
import { validHttpBoundary } from "../dist/http.js";

test("strict post URLs and usernames reject non-reading routes, credentials and lookalikes", () => {
  assert.equal(
    postUrl("https://twitter.com/Alice/status/123?s=20#ignored").url,
    "https://x.com/alice/status/123",
  );
  assert.equal(postUrl("https://x.com/i/status/123").id, "123");
  for (const input of [
    "http://x.com/a/status/1",
    "https://x.com.evil.test/a/status/1",
    "https://user:secret@x.com/a/status/1",
    "https://x.com:444/a/status/1",
    "https://x.com/a/status/1/likes",
    "file:///a/status/1",
    "https://x.com/settings/status/1",
    "https://x.com/a/../b/status/1",
    "https://x.com/a/status/0",
    "https://х.com/a/status/1",
  ]) {
    assert.throws(() => postUrl(input), undefined, input);
  }
  for (const input of [
    "settings",
    "a/b",
    "longer_than_15_characters",
    "alice?x=1",
  ])
    assert.throws(() => username(input));
  assert.equal(username("@Alice_1"), "alice_1");
  assert.throws(() =>
    threadInput.parse({ url: "https://x.com/a/status/1", max_depth: 9 }),
  );
  assert.throws(() => searchInput.parse({ query: "hello\nworld" }));
  assert.throws(() =>
    searchInput.parse({ query: "hello", javascript: "alert(1)" }),
  );
});

test("navigation and media capabilities cannot become arbitrary fetch or write endpoints", () => {
  assert.equal(navigationAllowed("https://x.com/alice/status/123"), true);
  for (const url of [
    "https://evil.test/",
    "https://x.com/messages",
    "https://x.com/notifications",
    "https://x.com/compose/post",
    "https://x.com/settings",
  ])
    assert.equal(navigationAllowed(url), false, url);
  assert.equal(
    allowedImage("https://pbs.twimg.com/media/abc?format=png&name=small"),
    true,
  );
  for (const url of [
    "http://127.0.0.1/",
    "https://pbs.twimg.com.evil.test/media/abc",
    "file:///secret.png",
    "https://pbs.twimg.com/profile_images/foo",
    "https://user:pass@pbs.twimg.com/media/abc",
  ])
    assert.equal(allowedImage(url), false);
});

test("cursors expire, are bounded, consume once, and bind to original arguments", () => {
  let time = 10;
  const cache = new ExpiringStore(100, 2, () => time);
  const first = cache.put("thread:a:2", { next: 2 });
  assert.throws(() => cache.take(first.id, "thread:b:2"), {
    code: "cursor_mismatch",
  });
  assert.deepEqual(cache.take(first.id, "thread:a:2").value, { next: 2 });
  assert.throws(() => cache.get(first.id), { code: "cursor_expired" });
  const expired = cache.put("a", 1);
  time += 101;
  assert.throws(() => cache.get(expired.id), { code: "cursor_expired" });
  const evicted = cache.put("a", 1);
  cache.put("b", 2);
  cache.put("c", 3);
  assert.equal(cache.size, 2);
  assert.throws(() => cache.get(evicted.id));
});

test("unexpected exceptions redact all browser details and sensitive link query values", () => {
  const safe = publicError(
    new Error(
      "Cookie: FAKE_COOKIE; Authorization: Bearer FAKE_TOKEN C:/private/profile",
    ),
  );
  assert.equal(safe.code, "internal_error");
  assert.doesNotMatch(JSON.stringify(safe), /FAKE_|private|Cookie|Bearer/);
  assert.equal(
    safeEvidenceUrl("https://example.org/paper?token=FAKE_TOKEN&citation=7"),
    "https://example.org/paper?citation=7",
  );
});

test("HTTP rejects remote addresses, hostile Host and Origin even on loopback", () => {
  const request = {
    headers: { host: "127.0.0.1:8765" },
    socket: { remoteAddress: "127.0.0.1" },
  };
  assert.equal(validHttpBoundary(request, 8765), true);
  assert.equal(
    validHttpBoundary(
      { ...request, headers: { host: "evil.test:8765" } },
      8765,
    ),
    false,
  );
  assert.equal(
    validHttpBoundary(
      {
        ...request,
        headers: { ...request.headers, origin: "https://evil.test" },
      },
      8765,
    ),
    false,
  );
  assert.equal(
    validHttpBoundary(
      { ...request, socket: { remoteAddress: "192.168.1.5" } },
      8765,
    ),
    false,
  );
});
