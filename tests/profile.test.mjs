import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  copyFile,
  writeFile,
  access,
  rm,
  symlink,
} from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { ROOT, LOCAL, PROFILE } from "../dist/config.js";

test("profile path ignores cwd; locks hand off; reset is confined and requires exact confirmation", async () => {
  await mkdir(LOCAL, { recursive: true });
  const project = await mkdtemp(join(LOCAL, "profile-test-"));
  const dist = join(project, "dist");
  await mkdir(dist);
  await writeFile(join(project, "package.json"), '{"type":"module"}');
  for (const file of ["config.js", "profile.js", "errors.js"])
    await copyFile(join(ROOT, "dist", file), join(dist, file));
  const config = await import(pathToFileURL(join(dist, "config.js")).href);
  const profile = await import(pathToFileURL(join(dist, "profile.js")).href);
  assert.notEqual(
    config.PROFILE,
    PROFILE,
    "the real authenticated profile is never used by this test",
  );
  assert.equal(config.PROFILE, resolve(project, ".local/x-browser-profile"));
  try {
    const previousCwd = process.cwd();
    process.chdir(dist);
    try {
      assert.equal(await profile.safeProfilePath(), config.PROFILE);
    } finally {
      process.chdir(previousCwd);
    }
    let release = await profile.acquireProfile();
    await assert.rejects(profile.acquireProfile(), { code: "profile_locked" });
    let context;
    try {
      context = await chromium.launchPersistentContext(config.PROFILE, {
        headless: true,
      });
      await context.route("https://x.com/**", (route) =>
        route.fulfill({
          body: "<html>Synthetic storage reuse test</html>",
          contentType: "text/html",
        }),
      );
      const page = context.pages()[0];
      await page.goto("https://x.com/home");
      await page.evaluate(() =>
        localStorage.setItem("synthetic-test-marker", "retained"),
      );
    } finally {
      await context?.close();
      await release();
    }
    release = await profile.acquireProfile();
    try {
      context = await chromium.launchPersistentContext(config.PROFILE, {
        headless: true,
      });
      await context.route("https://x.com/**", (route) =>
        route.fulfill({
          body: "<html>Synthetic storage reuse test</html>",
          contentType: "text/html",
        }),
      );
      const page = context.pages()[0];
      await page.goto("https://x.com/home");
      assert.equal(
        await page.evaluate(() =>
          localStorage.getItem("synthetic-test-marker"),
        ),
        "retained",
      );
    } finally {
      await context.close();
      await release();
    }
    await assert.rejects(profile.resetProfile("yes"), {
      code: "confirmation_required",
    });
    await profile.resetProfile("RESET x-reader");
    await assert.rejects(access(config.PROFILE));
    const unexpected = join(project, "unexpected");
    await mkdir(unexpected);
    await writeFile(join(unexpected, "keep.txt"), "keep");
    await symlink(
      unexpected,
      config.PROFILE,
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(profile.resetProfile("RESET x-reader"), {
      code: "unsafe_profile",
    });
    await access(join(unexpected, "keep.txt"));
    await rm(config.PROFILE); // Remove only the test junction, never its target.
  } finally {
    assert.ok(!relative(LOCAL, project).startsWith("..") && project !== LOCAL);
    await rm(project, { recursive: true, force: true });
  }
});

test("real browser work serializes, cancels and releases the profile for the next command", async () => {
  const project = await mkdtemp(join(LOCAL, "browser-test-"));
  const dist = join(project, "dist");
  await mkdir(dist);
  await writeFile(join(project, "package.json"), '{"type":"module"}');
  for (const file of [
    "config.js",
    "profile.js",
    "errors.js",
    "browser.js",
    "login.js",
    "validation.js",
  ])
    await copyFile(join(ROOT, "dist", file), join(dist, file));
  const previousDeadline = process.env.X_READER_DEADLINE_MS;
  process.env.X_READER_DEADLINE_MS = "5000";
  const { BrowserSession } = await import(
    pathToFileURL(join(dist, "browser.js")).href
  );
  if (previousDeadline === undefined) delete process.env.X_READER_DEADLINE_MS;
  else process.env.X_READER_DEADLINE_MS = previousDeadline;
  const { acquireProfile } = await import(
    pathToFileURL(join(dist, "profile.js")).href
  );
  const browser = new BrowserSession();
  try {
    const events = [];
    let entered;
    const firstReady = new Promise((resolve) => {
      entered = resolve;
    });
    let finish;
    const barrier = new Promise((resolve) => {
      finish = resolve;
    });
    const first = browser.run(async (page) => {
      await page.setContent("<p>Synthetic first job</p>");
      events.push("first");
      entered();
      await barrier;
      events.push("first done");
    });
    await firstReady;
    const cancelled = new AbortController();
    const second = browser.run(async () => {
      events.push("second should not run");
    }, cancelled.signal);
    const secondRejection = assert.rejects(second, { code: "cancelled" });
    cancelled.abort();
    finish();
    await first;
    await secondRejection;
    assert.deepEqual(events, ["first", "first done"]);
    const active = new AbortController();
    const aborted = browser.run(async (page) => {
      await page.setContent("<p>Synthetic cancellation</p>");
      const waiting = page.waitForSelector("#will-never-exist", {
        timeout: 30000,
      });
      active.abort();
      await waiting;
    }, active.signal);
    await assert.rejects(aborted, { code: "cancelled" });
    const release = await acquireProfile();
    await release();
    const queued = await Promise.all(
      [1, 2].map((id) =>
        browser.run(async (page) => {
          await page.setContent(`<p>Queued job ${id}</p>`);
          await page.waitForTimeout(2800);
          return page.locator("p").innerText();
        }),
      ),
    );
    assert.deepEqual(
      queued,
      ["Queued job 1", "Queued job 2"],
      "Queue wait must not consume the next job's five-second retrieval budget",
    );
    await assert.rejects(
      browser.run(async (page) => {
        await page.setContent("<p>Synthetic deadline</p>");
        await page.waitForSelector("#will-never-exist", { timeout: 30000 });
      }),
      { code: "deadline" },
    );
  } finally {
    await browser.close();
    assert.ok(!relative(LOCAL, project).startsWith("..") && project !== LOCAL);
    await rm(project, { recursive: true, force: true });
  }
});
