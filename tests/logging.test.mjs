import test from "node:test";
import assert from "node:assert/strict";
import {
  logEvent,
  logFailure,
  ReaderError,
  requestContext,
} from "../dist/errors.js";

test("readable logs include request outcomes, request details and safe diagnostics", (t) => {
  const previous = process.env.X_READER_LOG_FORMAT;
  process.env.X_READER_LOG_FORMAT = "text";
  t.after(() => {
    if (previous === undefined) delete process.env.X_READER_LOG_FORMAT;
    else process.env.X_READER_LOG_FORMAT = previous;
  });
  const lines = [];
  t.mock.method(console, "error", (line) => lines.push(line));
  requestContext.run("request-123", () => {
    logEvent({
      level: "info",
      event: "request_finished",
      tool: "search_x",
      duration_ms: 1240,
      posts: 12,
      query: "from:alice cats",
      request_id: "explicit-id",
    });
    logFailure(new ReaderError("login_required", "Sign in locally."));
    logFailure(new Error("SECRET browser details"));
    logEvent({ level: "warn", message: "Tunnel: broken\nline\u001b[31m" });
  });
  assert.match(
    lines[0],
    /^\[INFO\]\[\d{2}:\d{2}:\d{2}\] search_x completed in 1240ms \(posts=12 query="from:alice cats"\)$/,
  );
  assert.match(lines[1], /\[WARN\].*Sign in locally.*code=login_required/);
  assert.match(lines[2], /\[ERROR\].*Unexpected local failure/);
  assert.doesNotMatch(
    lines.join(""),
    /SECRET|request_id|request-123|explicit-id|[\n\x1b]/,
  );
});
