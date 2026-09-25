import { chromium, type BrowserContext, type Page } from "playwright";
import { access } from "node:fs/promises";
import { config, PROFILE } from "./config.js";
import { acquireProfile } from "./profile.js";
import { ReaderError, logEvent } from "./errors.js";
import type { Status, StopReason } from "./schema.js";
import { checkEdgeProfilePolicy, edgeExecutable } from "./login.js";
import { username } from "./validation.js";

export type PageState =
  | "ready"
  | "loading"
  | "login_required"
  | "challenge"
  | "rate_limited"
  | "account_restricted"
  | "protected_content"
  | "unavailable"
  | "navigation_error";

/** Only inspect UI state, never inputs, cookies, storage or request payloads. */
export async function pageState(page: Page): Promise<PageState> {
  const path = new URL(page.url()).pathname;
  if (/^\/(i\/flow\/(login|signup)|login)(\/|$)/.test(path))
    return "login_required";
  if (/^\/(account\/access|i\/flow\/challenge)/.test(path)) return "challenge";
  return page.evaluate(() => {
    const visible = (element: Element | null) =>
      !!element && element.getClientRects().length > 0;
    const authed =
      visible(
        document.querySelector(
          '[data-testid="SideNav_AccountSwitcher_Button"]',
        ),
      ) ||
      visible(document.querySelector('[data-testid="AppTabBar_Profile_Link"]'));
    if (
      visible(
        document.querySelector(
          'iframe[src*="arkoselabs"], iframe[src*="captcha"], [data-testid="challenge"]',
        ),
      )
    )
      return "challenge";
    // Source posts are untrusted: their words must not drive access-state detection.
    const main = (
      document.querySelector('[data-testid="primaryColumn"]') ??
      document.querySelector("main")
    )?.cloneNode(true) as HTMLElement | undefined;
    main
      ?.querySelectorAll(
        'article, [data-testid="tweet"], script, style, input, textarea',
      )
      .forEach((e) => e.remove());
    const text = main?.textContent ?? "";
    if (
      /rate limit exceeded|you are rate limited|too many requests|try again in a few (?:minutes|hours)/i.test(
        text,
      )
    )
      return "rate_limited";
    if (
      /account (?:is |has been )?(?:suspended|locked|restricted)|temporarily limited/i.test(
        text,
      )
    )
      return "account_restricted";
    if (
      /authenticate your account|verify (?:that )?you(?: are|[’']re) (?:a )?human|unusual activity|complete.*(?:captcha|challenge)/i.test(
        text,
      )
    )
      return "challenge";
    if (
      /these posts are protected|these tweets are protected|only (?:approved|confirmed) followers/i.test(
        text,
      )
    )
      return "protected_content";
    if (/something went wrong|try reloading|failed to load/i.test(text))
      return "navigation_error";
    if (
      /this (?:post|tweet) (?:is unavailable|was deleted)|(?:hmm.*)?this page doesn(?:’|')t exist|something went wrong.*try reloading/i.test(
        text,
      )
    )
      return "unavailable";
    if (
      !authed &&
      visible(
        document.querySelector(
          'a[href="/login"], a[href="/i/flow/login"], [data-testid="loginButton"]',
        ),
      )
    )
      return "login_required";
    return authed ? "ready" : "loading";
  });
}

export function navigationAllowed(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(
        url.hostname,
      ) ||
      url.username ||
      url.password ||
      url.port
    )
      return false;
    if (
      /^\/(?:home|search|login|account\/access|i\/flow\/(?:login|challenge)|i\/status\/[1-9][0-9]{0,24})\/?$/.test(
        url.pathname,
      )
    )
      return true;
    const match =
      /^\/([A-Za-z0-9_]{1,15})(?:\/status\/[1-9][0-9]{0,24})?\/?$/.exec(
        url.pathname,
      );
    return !!match && !!username(match[1]!);
  } catch {
    return false;
  }
}

export function sameReadingTarget(requested: string, actual: string): boolean {
  if (!navigationAllowed(actual)) return false;
  const expected = new URL(requested);
  const observed = new URL(actual);
  const postId = /\/status\/([1-9][0-9]{0,24})\/?$/;
  const expectedId = postId.exec(expected.pathname)?.[1];
  if (expectedId) return postId.exec(observed.pathname)?.[1] === expectedId;
  if (
    expected.pathname.replace(/\/$/, "").toLowerCase() !==
    observed.pathname.replace(/\/$/, "").toLowerCase()
  )
    return false;
  return (
    expected.pathname !== "/search" ||
    (expected.searchParams.get("q") === observed.searchParams.get("q") &&
      expected.searchParams.get("f") === observed.searchParams.get("f"))
  );
}

export function checkSignal(signal: AbortSignal): void {
  if (signal.aborted)
    throw new ReaderError(
      signal.reason?.name === "TimeoutError" ? "deadline" : "cancelled",
      "Retrieval stopped; any collected posts are a partial sample.",
    );
}

export async function navigate(
  page: Page,
  url: string,
  signal: AbortSignal,
): Promise<void> {
  checkSignal(signal);
  if (!navigationAllowed(url))
    throw new ReaderError(
      "unexpected_redirect",
      "Navigation outside the narrow public-reading routes was refused.",
    );
  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: config.navigationMs,
    });
    if (response?.status() === 429)
      throw new ReaderError(
        "rate_limited",
        "X returned a rate limit. Stop requests and wait before trying again.",
      );
    if (response && response.status() >= 500)
      throw new ReaderError(
        "navigation_error",
        "X returned a temporary server failure. Retry the unchanged request after a short wait.",
      );
    if (response?.status() === 401)
      throw new ReaderError("login_required", actionFor("login_required"));
    if (!navigationAllowed(page.url()))
      throw new ReaderError(
        "unexpected_redirect",
        "X redirected outside the allowed public-reading routes.",
      );
    await page
      .waitForFunction(
        () =>
          !!document.querySelector(
            '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Profile_Link"], [data-testid="loginButton"], a[href="/i/flow/login"], iframe[src*="captcha"], [data-testid="error-detail"]',
          ),
        {},
        { timeout: config.navigationMs },
      )
      .catch(() => {});
    const state = await pageState(page);
    if (state !== "ready")
      throw new ReaderError(
        state === "loading" ? "navigation_error" : state,
        actionFor(state),
      );
    if (!sameReadingTarget(url, page.url()))
      throw new ReaderError(
        "unexpected_redirect",
        "X redirected to a different post, profile or search. No substitute page was collected.",
      );
  } catch (error) {
    checkSignal(signal);
    if (error instanceof ReaderError) throw error;
    throw new ReaderError(
      "navigation_error",
      "The X page failed to load within the navigation budget. Check network access and retry the unchanged request.",
    );
  }
}

export function actionFor(state: string): string {
  if (state === "navigation_error")
    return "X could not load this page. Check network access and retry the unchanged request after a short wait.";
  if (state === "login_required")
    return "Run npm run login, sign in manually, close the browser normally, then retry.";
  if (state === "challenge" || state === "account_restricted")
    return "Stop automated requests. Open npm run login and review X's message yourself; x-reader cannot bypass it.";
  if (state === "rate_limited")
    return "Stop requests and wait for X's limit to clear; do not repeatedly retry.";
  if (state === "protected_content")
    return "Protected-account content is outside x-reader's public-post scope.";
  if (state === "unavailable")
    return "X reports this public page or post as unavailable.";
  return "X did not reach a recognized authenticated state. Check network access and run npm run login if needed.";
}

export class BrowserSession {
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  private activeClose: (() => Promise<void>) | null = null;
  private stopped = false;
  private blocked: string | null = null;

  async run<T>(
    work: (page: Page, signal: AbortSignal) => Promise<T>,
    parent?: AbortSignal,
  ): Promise<T> {
    if (this.stopped)
      throw new ReaderError("shutdown", "x-reader is shutting down.");
    if (this.blocked)
      throw new ReaderError(
        this.blocked,
        `${actionFor(this.blocked)} Restart x-reader after resolving it.`,
      );
    if (this.queued >= 8)
      throw new ReaderError(
        "busy",
        "The local browser queue is full. Wait for the current request.",
      );
    this.queued++;
    const queuedAt = Date.now();
    const before = this.tail;
    let done!: () => void;
    this.tail = new Promise((resolve) => {
      done = resolve;
    });
    const waiting = AbortSignal.any([
      AbortSignal.timeout(config.queueMs),
      ...(parent ? [parent] : []),
    ]);
    // Queue entries keep their place even if cancelled; they never overtake a live owner.
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () =>
          reject(
            new ReaderError(
              parent?.aborted ? "cancelled" : "busy",
              parent?.aborted
                ? "Request cancelled while waiting for the browser."
                : "Browser queue wait exceeded its budget. Retry fewer concurrent requests.",
            ),
          );
        waiting.addEventListener("abort", abort, { once: true });
        before.then(() => {
          waiting.removeEventListener("abort", abort);
          resolve();
        });
        if (waiting.aborted) abort();
      });
    } catch (error) {
      this.queued--;
      void before.then(done);
      throw error;
    }
    const started = Date.now();
    logEvent({
      level: "info",
      event: "browser_acquired",
      queue_wait_ms: started - queuedAt,
    });
    const signal = AbortSignal.any([
      AbortSignal.timeout(config.deadlineMs),
      ...(parent ? [parent] : []),
    ]);
    let release: (() => Promise<void>) | undefined;
    let context: BrowserContext | undefined;
    let closePromise: Promise<void> | undefined;
    const closeContext = (): Promise<void> =>
      (closePromise ??= context?.close().catch(() => {}) ?? Promise.resolve());
    let abort: (() => void) | undefined;
    try {
      checkSignal(signal);
      if (this.stopped)
        throw new ReaderError("shutdown", "x-reader is shutting down.");
      if (this.blocked)
        throw new ReaderError(this.blocked, actionFor(this.blocked));
      release = await acquireProfile();
      await checkEdgeProfilePolicy();
      context = await chromium
        .launchPersistentContext(PROFILE, {
          channel: config.browserChannel,
          headless: config.headless,
          viewport: { width: 1280, height: 900 },
          acceptDownloads: false,
          serviceWorkers: "block",
          timeout: Math.max(
            1,
            Math.min(
              config.navigationMs,
              config.deadlineMs - (Date.now() - started),
            ),
          ),
        })
        .catch(() => {
          throw new ReaderError(
            "browser_launch_failed",
            "Could not start the dedicated browser. Run npm run browser:install; close other processes using the dedicated profile.",
          );
        });
      this.activeClose = closeContext;
      abort = () => {
        void closeContext();
      };
      signal.addEventListener("abort", abort, { once: true });
      checkSignal(signal);
      const page = context.pages()[0] ?? (await context.newPage());
      for (const other of context.pages())
        if (other !== page) await other.close();
      context.on("page", (other) => {
        if (other !== page) void other.close().catch(() => {});
      });
      await context.route("**/*", async (route) => {
        const request = route.request();
        if (
          request.resourceType() === "media" ||
          (request.isNavigationRequest() &&
            request.frame() === page.mainFrame() &&
            !navigationAllowed(request.url()))
        )
          await route.abort();
        else await route.continue();
      });
      return await work(page, signal);
    } catch (error) {
      if (
        error instanceof ReaderError &&
        ["challenge", "rate_limited", "account_restricted"].includes(error.code)
      )
        this.blocked = error.code;
      checkSignal(signal);
      throw error;
    } finally {
      try {
        if (abort) signal.removeEventListener("abort", abort);
        await closeContext();
        this.activeClose = null;
        await release?.();
      } finally {
        this.queued--;
        done();
      }
    }
  }

  latch(reason: StopReason): void {
    if (["challenge", "rate_limited", "account_restricted"].includes(reason))
      this.blocked = reason;
  }

  async status(signal?: AbortSignal): Promise<Status> {
    const base = {
      checked_at: new Date().toISOString(),
      browser_available:
        process.platform === "win32"
          ? await edgeExecutable().then(
              () => true,
              () => false,
            )
          : await access(chromium.executablePath()).then(
              () => true,
              () => false,
            ),
      dedicated_profile_exists: await access(PROFILE).then(
        () => true,
        () => false,
      ),
    };
    if (!base.browser_available)
      return {
        ...base,
        ready: false,
        state: "browser_missing",
        action:
          process.platform === "win32"
            ? "Install Microsoft Edge, then run npm run login."
            : "Run npm run browser:install.",
      };
    if (!base.dedicated_profile_exists)
      return {
        ...base,
        ready: false,
        state: "login_required",
        action: actionFor("login_required"),
      };
    try {
      await this.run(async (page, activeSignal) => {
        await navigate(page, "https://x.com/home", activeSignal);
      }, signal);
      return { ...base, ready: true, state: "ready", action: null };
    } catch (error) {
      const state = error instanceof ReaderError ? error.code : "browser_error";
      return {
        ...base,
        ready: false,
        state,
        action:
          error instanceof ReaderError
            ? error.message
            : "Run npm run diagnostics.",
      };
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    await this.activeClose?.();
    await this.tail;
  }
}
