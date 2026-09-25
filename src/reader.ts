import { z } from "zod";
import type { Page } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserSession, checkSignal } from "./browser.js";
import { config, LOCAL } from "./config.js";
import { ExpiringStore } from "./cache.js";
import { ReaderError, publicError, logEvent } from "./errors.js";
import { collectPage, screenshotMedia } from "./dom.js";
import { captureVideo, type VideoRef } from "./video.js";
import type { MediaImage } from "./media.js";
import {
  postUrl,
  username,
  getPostInput,
  threadInput,
  searchInput,
  userInput,
  allowedImage,
  readVideoInput,
} from "./validation.js";
import {
  stopReasons,
  type Post,
  type Report,
  type ReadResult,
  type StopReason,
} from "./schema.js";

type BrowserPort = Pick<BrowserSession, "run" | "status" | "latch" | "close">;
type Task = { url: string; depth: number };
type Traversal = {
  pending: Post[];
  posts: Map<string, Post>;
  delivered: Set<string>;
  queue: Task[];
  scheduled: Set<string>;
  report: Report;
  maxDepth: number;
  snapshot: boolean;
  terminal: boolean;
};
export type MediaRef = { post_url: string; post_id: string; src: string };
export type { MediaImage } from "./media.js";
type StoredMedia =
  | MediaRef
  | VideoRef
  | { type: "video_frame"; video: VideoRef; timestamp: number };
type MediaResult =
  | { media_id: string; image: MediaImage }
  | { media_id: string; error: { code: string; message: string } };
const clearMarker = join(LOCAL, "cache-generation");
const blockedReasons = new Set([
  "login_required",
  "challenge",
  "rate_limited",
  "account_restricted",
  "protected_content",
  "unexpected_redirect",
]);

function initial(focalId: string | null, maxDepth: number): Traversal {
  const now = new Date().toISOString();
  return {
    pending: [],
    posts: new Map(),
    delivered: new Set(),
    queue: [],
    scheduled: new Set(),
    maxDepth,
    snapshot: false,
    terminal: false,
    report: {
      retrieved_at: now,
      started_at: now,
      focal_id: focalId,
      observed_root_id: null,
      ancestor_context_ids: [],
      ordering: [],
      posts_collected: 0,
      total_collected: 0,
      depth_reached: 0,
      unresolved_parents: 0,
      unexpanded_branches: [],
      stop_reason: "no_further_visible_content",
      pages_visited: 0,
      scrolls: 0,
      complete: false,
      limitations: [
        "This is a bounded sample of rendered public posts, never an enumeration of all replies or all of X.",
        "Null parent IDs are unknown. Adjacency, mentions and conversation membership do not establish an exact parent.",
        "Traversal depth counts page-expansion hops from the focal post, not proven reply-chain depth. The UI does not always identify the conversation root.",
        "Quoted posts are separate source material, not replies. Quote-posts elsewhere are not enumerated.",
        "Image interpretation belongs to the calling model and must remain separate from post/Article text. Check media_content for supplied pixels and limitations; read_media retrieves deferred images. Use read_video for discovered video IDs; sparse frames cannot establish continuous coverage.",
      ],
    },
  };
}

function stopFrom(error: unknown, signal?: AbortSignal): StopReason {
  if (signal?.aborted)
    return signal.reason?.name === "TimeoutError" ? "deadline" : "cancelled";
  return error instanceof ReaderError &&
    (stopReasons as readonly string[]).includes(error.code)
    ? (error.code as StopReason)
    : "extraction_error";
}

export class Reader {
  private readonly cursors = new ExpiringStore<Traversal>(config.cacheMs, 4);
  private readonly media = new ExpiringStore<StoredMedia>(config.cacheMs, 1000);
  private generation: string | undefined;
  constructor(private readonly browser: BrowserPort = new BrowserSession()) {}

  private async syncCache(): Promise<void> {
    const value = await readFile(clearMarker, "utf8").catch(() => "");
    if (this.generation !== undefined && value !== this.generation) {
      this.cursors.clear();
      this.media.clear();
    }
    this.generation = value;
  }

  async status(signal?: AbortSignal) {
    await this.syncCache();
    return this.browser.status(signal);
  }
  async close(): Promise<void> {
    this.cursors.clear();
    this.media.clear();
    await this.browser.close();
  }

  private pageProgress(state: Traversal) {
    const previousScrolls = state.report.scrolls;
    return (progress: { ordering: string; scrolls: number }): void => {
      state.report.scrolls = previousScrolls + progress.scrolls;
      if (!state.report.ordering.includes(progress.ordering))
        state.report.ordering.push(progress.ordering);
    };
  }

  private remember(state: Traversal, post: Post): void {
    if (state.posts.size >= 200 && !state.posts.has(post.id)) {
      state.report.stop_reason = "total_budget";
      state.terminal = true;
      return;
    }
    if (post.id === state.report.focal_id) post.relation = "focal";
    const existing = state.posts.get(post.id);
    if (existing) {
      // A later expanded rendering can improve text without adding another post.
      if (!state.delivered.has(post.id)) {
        if ((post.text?.length ?? 0) > (existing.text?.length ?? 0)) {
          existing.text = post.text;
          existing.truncated = post.truncated;
        }
        if (
          post.article &&
          (!existing.article ||
            (post.article.text?.length ?? 0) >
              (existing.article.text?.length ?? 0) ||
            (existing.article.truncated && !post.article.truncated))
        ) {
          existing.article = post.article;
          this.rememberMedia(post);
        }
        if (!existing.parent_id && post.parent_id) {
          existing.parent_id = post.parent_id;
          existing.parent_evidence = post.parent_evidence;
        }
      }
      return;
    }
    this.rememberMedia(post);
    state.posts.set(post.id, post);
    state.pending.push(post);
    state.report.depth_reached = Math.max(
      state.report.depth_reached,
      post.traversal_depth,
    );
    if (
      post.relation === "ancestor_context" &&
      !state.report.ancestor_context_ids.includes(post.id)
    )
      state.report.ancestor_context_ids.push(post.id);
  }

  private rememberMedia(post: Post): void {
    for (const item of [
      ...post.media,
      ...(post.article?.media ?? []),
      ...post.quoted_posts.flatMap((quote) => [
        ...quote.media,
        ...(quote.article?.media ?? []),
      ]),
    ]) {
      if (
        item.type === "image" &&
        item.url &&
        allowedImage(item.url) &&
        !item.media_id
      )
        item.media_id = this.media.put(post.id, {
          post_url: post.url,
          post_id: post.id,
          src: item.url,
        }).id;
    }
    for (const owner of [post, ...post.quoted_posts]) {
      if (!owner.id || !owner.url) continue;
      const videos = [...owner.media, ...(owner.article?.media ?? [])].filter(
        (item) => item.type === "video",
      );
      for (const [index, item] of videos.entries()) {
        if (!item.media_id)
          item.media_id = this.media.put(owner.id, {
            type: "video",
            post_url: owner.url,
            post_id: owner.id,
            src: item.url ?? "",
            index,
          }).id;
      }
    }
  }

  private schedule(state: Traversal, post: Post): void {
    if (post.relation !== "conversation" || state.scheduled.has(post.id))
      return;
    state.scheduled.add(post.id);
    if (post.traversal_depth >= state.maxDepth) {
      state.report.unexpanded_branches.push({
        post_id: post.id,
        reason: "depth_budget",
      });
    } else if (state.queue.length < 200) {
      state.queue.push({ url: post.url, depth: post.traversal_depth });
    }
  }

  private output(
    state: Traversal,
    key: string,
    limit: number,
    expires?: number,
  ): ReadResult {
    if (!state.delivered.size && state.report.focal_id)
      state.pending.sort(
        (a, b) =>
          Number(b.id === state.report.focal_id) -
          Number(a.id === state.report.focal_id),
      );
    const posts: Post[] = [];
    let bytes = 0;
    while (state.pending.length && posts.length < limit) {
      const next = state.pending[0]!;
      const size = Buffer.byteLength(JSON.stringify(next));
      if (posts.length && bytes + size > 240_000) break;
      bytes += size;
      posts.push(state.pending.shift()!);
      state.delivered.add(next.id);
    }
    const remaining =
      state.pending.length > 0 || (!state.terminal && state.queue.length > 0);
    const next = remaining ? this.cursors.put(key, state, expires) : null;
    const queuedBranches = state.queue.map((task) => ({
      post_id: postUrl(task.url).id,
      reason: state.terminal ? state.report.stop_reason : "pending_cursor",
    }));
    const report = structuredClone(state.report);
    report.retrieved_at = new Date().toISOString();
    report.posts_collected = posts.length;
    report.total_collected = state.posts.size;
    report.unresolved_parents = [...state.posts.values()].filter(
      (post) => post.parent_id === null,
    ).length;
    report.unexpanded_branches = [
      ...report.unexpanded_branches,
      ...queuedBranches,
    ].slice(0, 200);
    if (
      remaining &&
      (state.pending.length > 0 || posts.length >= limit) &&
      !blockedReasons.has(report.stop_reason) &&
      ![
        "deadline",
        "cancelled",
        "extraction_error",
        "navigation_error",
        "total_budget",
      ].includes(report.stop_reason)
    )
      report.stop_reason = "configured_limit";
    if (state.snapshot && !remaining && !blockedReasons.has(report.stop_reason))
      report.limitations.push(
        "This continuation reached the end of a stored, bounded snapshot; it does not prove the website had no more results.",
      );
    return {
      posts,
      report,
      next_cursor: next?.id ?? null,
      cursor_expires_at: next ? new Date(next.expires).toISOString() : null,
    };
  }

  async getPost(
    input: z.input<typeof getPostInput>,
    signal?: AbortSignal,
  ): Promise<ReadResult> {
    const args = getPostInput.parse(input);
    await this.syncCache();
    const target = postUrl(args.url);
    const state = initial(target.id, 0);
    try {
      await this.browser.run(async (page, active) => {
        state.report.pages_visited = 1;
        await collectPage(
          page,
          target.url,
          "post",
          active,
          (post) => {
            if (post.id === target.id) this.remember(state, post);
          },
          { depth: 0, maxDepth: 0, onProgress: this.pageProgress(state) },
        );
        state.report.stop_reason = "requested_post";
      }, signal);
    } catch (error) {
      if (!state.posts.size) throw error;
      state.report.stop_reason = stopFrom(error, signal);
    }
    return this.output(state, `post:${target.id}`, 1);
  }

  async getThread(
    input: z.input<typeof threadInput>,
    signal?: AbortSignal,
  ): Promise<ReadResult> {
    const args = threadInput.parse(input);
    await this.syncCache();
    const target = postUrl(args.url);
    const key = `thread:${target.id}:${args.max_posts}:${args.max_depth}`;
    const cached = args.cursor ? this.cursors.take(args.cursor, key) : null;
    const state = cached?.value ?? initial(target.id, args.max_depth);
    if (!cached) {
      state.queue.push({ url: target.url, depth: 0 });
      state.scheduled.add(target.id);
    }
    if (
      state.pending.length < args.max_posts &&
      state.queue.length &&
      !state.terminal
    ) {
      try {
        await this.browser.run(async (page, active) => {
          let visits = 0;
          while (
            state.queue.length &&
            state.pending.length < args.max_posts &&
            visits < config.pages &&
            state.report.pages_visited < 32 &&
            !state.terminal
          ) {
            checkSignal(active);
            const task = state.queue.shift()!;
            state.report.pages_visited++;
            visits++;
            try {
              const result = await collectPage(
                page,
                task.url,
                "thread",
                active,
                (post) => {
                  if (task.url !== target.url && post.relation === "focal")
                    post.relation = "conversation";
                  this.remember(state, post);
                  this.schedule(state, post);
                },
                {
                  depth: task.depth,
                  maxDepth: args.max_depth,
                  onProgress: this.pageProgress(state),
                },
              );
              state.report.stop_reason = state.terminal
                ? "total_budget"
                : result.stop_reason;
              if (
                ["scroll_budget", "depth_budget", "configured_limit"].includes(
                  result.stop_reason,
                ) ||
                result.unexpanded
              )
                state.report.unexpanded_branches.push({
                  post_id: postUrl(task.url).id,
                  reason: result.unexpanded
                    ? "visible_controls_remaining"
                    : result.stop_reason,
                });
            } catch (error) {
              const reason = stopFrom(error, active);
              state.report.unexpanded_branches.push({
                post_id: postUrl(task.url).id,
                reason,
              });
              state.report.stop_reason = reason;
              if (reason === "unavailable" && state.posts.size) continue;
              if (!state.posts.size) throw error;
              state.terminal =
                blockedReasons.has(reason) || reason === "unexpected_redirect";
              // Keep an unfinished node for a later bounded attempt, never retry it in this call.
              if (!state.terminal) state.queue.unshift(task);
              break;
            }
          }
          if (state.report.pages_visited >= 32) {
            state.terminal = true;
            state.report.stop_reason = "total_budget";
          } else if (
            visits >= config.pages &&
            state.queue.length &&
            state.pending.length < args.max_posts
          )
            state.report.stop_reason = "page_budget";
        }, signal);
      } catch (error) {
        if (!state.posts.size) throw error;
        state.report.stop_reason = stopFrom(error, signal);
      }
    }
    this.browser.latch(state.report.stop_reason);
    return this.output(state, key, args.max_posts, cached?.expires);
  }

  private async results(
    key: string,
    url: string,
    kind: "search" | "user",
    limit: number,
    cursor: string | undefined,
    sort: "latest" | "top" | undefined,
    signal?: AbortSignal,
  ): Promise<ReadResult> {
    await this.syncCache();
    const cached = cursor ? this.cursors.take(cursor, key) : null;
    const state = cached?.value ?? initial(null, 0);
    state.snapshot = true;
    if (!cached) {
      try {
        await this.browser.run(async (page: Page, active) => {
          state.report.pages_visited = 1;
          const result = await collectPage(
            page,
            url,
            kind,
            active,
            (post) => this.remember(state, post),
            {
              depth: 0,
              maxDepth: 0,
              sort,
              onProgress: this.pageProgress(state),
            },
          );
          state.report.stop_reason = result.stop_reason;
        }, signal);
      } catch (error) {
        if (!state.posts.size) throw error;
        state.report.stop_reason = stopFrom(error, signal);
      }
      state.terminal = true;
    }
    this.browser.latch(state.report.stop_reason);
    return this.output(state, key, limit, cached?.expires);
  }

  async search(
    input: z.input<typeof searchInput>,
    signal?: AbortSignal,
  ): Promise<ReadResult> {
    const args = searchInput.parse(input);
    const url = new URL("https://x.com/search");
    url.searchParams.set("q", args.query);
    url.searchParams.set("src", "typed_query");
    if (args.sort === "latest") url.searchParams.set("f", "live");
    const result = await this.results(
      `search:${args.query}:${args.sort}:${args.limit}`,
      url.href,
      "search",
      args.limit,
      args.cursor,
      args.sort,
      signal,
    );
    return { ...result, search: { query: args.query, sort: args.sort } };
  }

  userPosts(
    input: z.input<typeof userInput>,
    signal?: AbortSignal,
  ): Promise<ReadResult> {
    const args = userInput.parse(input);
    const handle = username(args.username);
    return this.results(
      `user:${handle}:${args.limit}`,
      `https://x.com/${handle}`,
      "user",
      args.limit,
      args.cursor,
      undefined,
      signal,
    );
  }

  async readMedia(id: string, signal?: AbortSignal): Promise<MediaImage> {
    const result = (await this.readMediaBatch([id], signal))[0]!;
    if ("error" in result)
      throw new ReaderError(result.error.code, result.error.message);
    return result.image;
  }

  async readVideo(input: z.input<typeof readVideoInput>, signal?: AbortSignal) {
    const options = readVideoInput.parse(input);
    await this.syncCache();
    const entry = this.media.get(options.media_id);
    if (!("type" in entry.value) || entry.value.type !== "video")
      throw new ReaderError(
        "media_refused",
        "read_video requires a video media_id discovered by retrieving a public post.",
      );
    const reference = entry.value;
    const result = await this.browser.run(
      (page, active) => captureVideo(page, reference, options, active),
      signal,
    );
    return {
      image: result.sheet,
      metadata: {
        ...result.metadata,
        frames: result.frames.map((frame, index) => ({
          media_id: this.media.put(
            reference.post_id,
            {
              type: "video_frame",
              video: reference,
              timestamp: result.requested[index]!,
            },
            entry.expires,
          ).id,
          requested_timestamp_seconds: result.requested[index]!,
          timestamp_seconds: frame.timestamp_seconds!,
          width: frame.width,
          height: frame.height,
          expires_at: new Date(entry.expires).toISOString(),
        })),
      },
    };
  }

  async readMediaBatch(
    ids: string[],
    signal?: AbortSignal,
  ): Promise<MediaResult[]> {
    await this.syncCache();
    return this.browser.run(async (page, active) => {
      const results: MediaResult[] = [];
      for (const id of ids.slice(0, 4)) {
        checkSignal(active);
        try {
          const { value } = this.media.get(z.string().uuid().parse(id));
          if ("type" in value) {
            if (value.type === "video")
              throw new ReaderError(
                "media_refused",
                "Use read_video for this video ID; then read_media with one of the returned frame IDs.",
              );
            const capture = await captureVideo(
              page,
              value.video,
              readVideoInput.parse({
                media_id: id,
                timestamps: [value.timestamp],
                frame_count: 1,
                max_frame_dimension: 2048,
              }),
              active,
            );
            results.push({ media_id: id, image: capture.frames[0]! });
            continue;
          }
          if (!allowedImage(value.src))
            throw new ReaderError(
              "media_refused",
              "Only images discovered on retrieved public posts can be read.",
            );
          const { bytes, ...capture } = await screenshotMedia(
            page,
            value,
            active,
          );
          if (bytes.length > 4 * 1024 * 1024)
            throw new ReaderError(
              "media_too_large",
              "Image exceeds the 4 MiB response limit.",
            );
          results.push({
            media_id: id,
            image: {
              ...capture,
              data: bytes.toString("base64"),
              mimeType: "image/png",
              post_url: value.post_url,
            },
          });
        } catch (error) {
          checkSignal(active);
          const failure = publicError(error);
          logEvent({
            level: failure.code === "internal_error" ? "error" : "warn",
            event: "media_unavailable",
            media_id: id,
            ...failure,
          });
          results.push({ media_id: id, error: failure });
          if (error instanceof ReaderError && blockedReasons.has(error.code)) {
            this.browser.latch(stopFrom(error));
            for (const remaining of ids.slice(results.length, 4))
              results.push({ media_id: remaining, error: failure });
            break;
          }
        }
      }
      return results;
    }, signal);
  }
}

export async function clearCache(): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(LOCAL, { recursive: true });
  await writeFile(clearMarker, crypto.randomUUID(), { mode: 0o600 });
}
