import type { Page } from "playwright";
import {
  navigate,
  pageState,
  actionFor,
  checkSignal,
  sameReadingTarget,
} from "./browser.js";
import { config } from "./config.js";
import { ReaderError, logEvent } from "./errors.js";
import { allowedImage, postUrl, safeEvidenceUrl } from "./validation.js";
import type { Article, Post, StopReason } from "./schema.js";
import type { MediaRef } from "./reader.js";

export type PageKind = "post" | "thread" | "search" | "user";
type Frame = {
  posts: Post[];
  protected_ids: string[];
  boundary: boolean;
  timeline: string | null;
  ordering: string;
  empty: boolean;
};

/** All website selectors and DOM interpretation live here. No private API or React state access. */
export async function extractVisible(
  page: Page,
  sourceUrl: string,
): Promise<Frame> {
  const frame = await page.evaluate((source): Frame => {
    const primary =
      document.querySelector('[data-testid="primaryColumn"]') ??
      document.querySelector("main");
    const timeline = primary?.querySelector('[aria-label^="Timeline:"]');
    const quoteRoots = (article: Element): Element[] => {
      const candidates = [
        ...article.querySelectorAll(
          'div[role="link"], [data-testid="quoteTweet"]',
        ),
      ].filter(
        (e) =>
          !e.closest('[data-testid="twitterArticleReadView"]') &&
          e.querySelector('[data-testid="User-Name"]') &&
          e.querySelector(
            'time, [data-testid="tweetText"], [data-testid="tweetPhoto"]',
          ),
      );
      return candidates.filter(
        (e) => !candidates.some((outer) => outer !== e && outer.contains(e)),
      );
    };
    const originalText = (element: Element | null): string | null => {
      if (!element) return null;
      const clone = element.cloneNode(true) as Element;
      clone
        .querySelectorAll("img[alt]")
        .forEach((img) =>
          img.replaceWith(
            document.createTextNode(img.getAttribute("alt") ?? ""),
          ),
        );
      clone
        .querySelectorAll("br")
        .forEach((br) => br.replaceWith(document.createTextNode("\n")));
      return clone.textContent?.replace(/\r\n/g, "\n") ?? null;
    };
    const canonical = (
      href: string | null,
    ): { id: string; url: string } | null => {
      if (!href) return null;
      try {
        const url = new URL(href, "https://x.com");
        if (url.origin !== "https://x.com") return null;
        const match =
          /^\/([A-Za-z0-9_]{1,15}|i)\/status\/([1-9][0-9]{0,24})(?:\/(?:photo|video)\/[1-4])?$/.exec(
            url.pathname,
          );
        return match
          ? {
              id: match[2]!,
              url: `https://x.com/${match[1]!.toLowerCase()}/status/${match[2]}`,
            }
          : null;
      } catch {
        return null;
      }
    };
    const author = (root: Element) => {
      const header = root.querySelector('[data-testid="User-Name"]');
      const spans = [...(header?.querySelectorAll("span") ?? [])];
      const handle = spans
        .map((span) => span.textContent)
        .find((text) => /^@[A-Za-z0-9_]{1,15}$/.test(text ?? ""));
      const display =
        header?.querySelector("a")?.textContent ||
        spans[0]?.textContent ||
        null;
      return {
        username: handle?.slice(1) ?? null,
        display_name: display?.slice(0, 200) ?? null,
      };
    };
    const media = (
      root: Element,
      exclude: Element[] = [],
      limit = 4,
    ): Post["media"] => {
      const images: Post["media"] = [
        ...root.querySelectorAll('[data-testid="tweetPhoto"] img'),
      ]
        .filter(
          (img) =>
            !exclude.some((quote) => quote.contains(img)) &&
            !img.closest('[data-testid="videoPlayer"]'),
        )
        .slice(0, limit)
        .map((img) => {
          const alt = img.getAttribute("alt");
          return {
            media_id: null,
            type: "image",
            url:
              (img as HTMLImageElement).currentSrc || img.getAttribute("src"),
            alt_text: alt && alt !== "Image" ? alt.slice(0, 2000) : null,
            limitation:
              "No server image analysis. Inspect the labeled MCP image content, or call read_media if pixels were not supplied. Keep image interpretation separate from source text.",
          };
        });
      const video = [
        ...root.querySelectorAll(
          'video, [data-testid="videoPlayer"], a[href^="/i/broadcasts/"]',
        ),
      ].find((e) => !exclude.some((q) => q.contains(e)));
      if (video)
        images.push({
          media_id: null,
          type: "video",
          url:
            video instanceof HTMLAnchorElement
              ? new URL(video.href, "https://x.com").href
              : null,
          alt_text: null,
          limitation:
            "Video metadata only; playback and transcription are not collected.",
        });
      return images;
    };
    const articleContent = (
      root: Element,
      exclude: Element[] = [],
    ): Article | undefined => {
      const view = [
        ...root.querySelectorAll('[data-testid="twitterArticleReadView"]'),
      ].find((e) => !exclude.some((q) => q.contains(e)));
      if (!view) return undefined;
      const body =
        view.querySelector('[data-testid="longformRichTextComponent"]') ??
        view.querySelector('[data-testid="twitterArticleRichTextView"]');
      const attachments = media(view, [], 64);
      const blocks: Article["blocks"] = [];
      const limitations: string[] = [];
      let length = 0;
      let truncated = !body;
      if (!body)
        limitations.push(
          "The Article body has not rendered. No OCR was substituted for page text.",
        );
      const draft = [...(body?.querySelectorAll('[data-block="true"]') ?? [])];
      const candidates = draft.length
        ? draft
        : [
            ...(body?.querySelectorAll(
              "h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,hr,figure,table",
            ) ?? []),
          ];
      const candidateSet = new Set(candidates);
      const nodes = candidates.filter((node) => {
        for (
          let parent = node.parentElement;
          parent && parent !== body;
          parent = parent.parentElement
        )
          if (candidateSet.has(parent)) return false;
        return true;
      });
      let missingEmbeds = 0;
      for (const node of nodes) {
        if (blocks.length >= 1000 || length >= 60000) {
          truncated = true;
          break;
        }
        const copy = node.cloneNode(true) as Element;
        copy
          .querySelectorAll(
            '[data-testid="tweetPhoto"], [data-testid="videoPlayer"], script, style, button, annotation, [aria-hidden="true"]',
          )
          .forEach((e) => e.remove());
        const table = copy.matches("table")
          ? copy
          : copy.querySelector("table");
        const rows = table
          ? [...table.querySelectorAll("tr")].map((row) =>
              [...row.querySelectorAll("th,td")].map(
                (cell) => originalText(cell)?.trim() ?? "",
              ),
            )
          : undefined;
        if (table && rows)
          table.replaceChildren(
            document.createTextNode(
              rows.map((row) => row.join("\t")).join("\n") + "\n",
            ),
          );
        const raw = originalText(copy)?.trim() ?? "";
        const text = raw.slice(0, 60000 - length);
        if (text.length < raw.length) truncated = true;
        length += text.length + 2;
        const indexes = [
          ...node.querySelectorAll('[data-testid="tweetPhoto"] img'),
        ].flatMap((img) => {
          const src =
            (img as HTMLImageElement).currentSrc || img.getAttribute("src");
          const index = attachments.findIndex((item) => item.url === src);
          return index >= 0 ? [index] : [];
        });
        const heading = /^H([1-6])$/.exec(node.tagName);
        if (indexes.length)
          blocks.push({
            type: "media",
            text: text || null,
            media_indexes: indexes,
          });
        else if (node.matches("hr") || node.querySelector('[role="separator"]'))
          blocks.push({ type: "separator", text: null });
        else if (heading)
          blocks.push({ type: "heading", text, level: Number(heading[1]) });
        else if (node.tagName === "LI")
          blocks.push({
            type: "list_item",
            text,
            ordered: !!node.closest("ol"),
            level: Number(
              /public-DraftStyleDefault-depth(\d+)/.exec(node.className)?.[1] ??
                0,
            ),
          });
        else if (node.tagName === "BLOCKQUOTE")
          blocks.push({ type: "blockquote", text });
        else if (
          node.tagName === "PRE" ||
          node.classList.contains("longform-code-block")
        )
          blocks.push({ type: "code", text });
        else if (rows)
          blocks.push({ type: "table", text, ...(truncated ? {} : { rows }) });
        else if (node.tagName === "SECTION") {
          blocks.push({ type: "embed", text: text || null });
          if (!text) missingEmbeds++;
        } else if (text) blocks.push({ type: "paragraph", text });
      }
      if (body && !nodes.length && body.textContent?.trim()) {
        // Preserve readable text if X changes its block markup, and disclose lost structure.
        const text = (body as HTMLElement).innerText.slice(0, 60000);
        blocks.push({ type: "paragraph", text });
        truncated = true;
        limitations.push(
          "Unrecognized Article block layout; only rendered plain text was collected.",
        );
      }
      if (body && !blocks.length) {
        truncated = true;
        limitations.push("The Article body is empty or still loading.");
      }
      if (truncated && body)
        limitations.push(
          "Article content is incomplete or exceeds the 60,000 character / 1,000 block budget.",
        );
      if (missingEmbeds)
        limitations.push(
          `${missingEmbeds} embedded blocks have no rendered text or image; their contents were not read.`,
        );
      if (view.querySelectorAll('[data-testid="tweetPhoto"] img').length > 64) {
        truncated = true;
        limitations.push("Article media exceeds the 64 image budget.");
      }
      const articleAuthor = author(view);
      if ((body?.querySelectorAll("a[href]").length ?? 0) > 128) {
        truncated = true;
        limitations.push("Article links exceed the 128 link budget.");
      }
      return {
        title:
          originalText(
            view.querySelector('[data-testid="twitter-article-title"]'),
          )?.trim() ?? null,
        author:
          articleAuthor.username &&
          !body?.contains(view.querySelector('[data-testid="User-Name"]'))
            ? articleAuthor
            : author(root),
        text:
          blocks
            .map((block) => block.text)
            .filter(Boolean)
            .join("\n\n") || null,
        blocks,
        links: [...(body?.querySelectorAll("a[href]") ?? [])]
          .slice(0, 128)
          .map((a) => ({
            url: (a as HTMLAnchorElement).href,
            display: originalText(a)?.slice(0, 300) ?? null,
          })),
        media: attachments,
        source: "rendered_dom",
        truncated: truncated || missingEmbeds > 0,
        limitations,
      };
    };
    const headings = [
      ...(timeline?.querySelectorAll('h1, h2, h3, [role="heading"]') ?? []),
    ].filter((e) => !e.closest("article"));
    const boundary = headings.find((e) =>
      /^(Discover more|More for you|You might like|Recommended|Who to follow|Related posts)$/i.test(
        e.textContent?.trim() ?? "",
      ),
    );
    const posts: Post[] = [];
    const protectedIds: string[] = [];
    for (const article of timeline?.querySelectorAll(
      'article[data-testid="tweet"]',
    ) ?? []) {
      if (article.parentElement?.closest('article[data-testid="tweet"]'))
        continue;
      if (
        boundary &&
        boundary.compareDocumentPosition(article) &
          Node.DOCUMENT_POSITION_FOLLOWING
      )
        continue;
      const quotes = quoteRoots(article);
      const articleViews = [
        ...article.querySelectorAll('[data-testid="twitterArticleReadView"]'),
      ];
      const own = <T extends Element>(elements: Iterable<T>): T[] =>
        [...elements].filter(
          (e) =>
            !quotes.some((q) => q.contains(e)) &&
            !articleViews.some((view) => view.contains(e)),
        );
      const userHeader = article.querySelector('[data-testid="User-Name"]');
      if (
        userHeader?.querySelector(
          '[data-testid="icon-lock"], [aria-label="Protected account"]',
        )
      ) {
        const protectedId = canonical(
          own(article.querySelectorAll("a:has(time)"))[0]?.getAttribute(
            "href",
          ) ?? null,
        )?.id;
        if (protectedId) protectedIds.push(protectedId);
        continue;
      }
      // Video players also contain placementTracking; an inner tracker is not an ad label.
      if (
        own(
          article.querySelectorAll(
            '[data-testid="promotedIndicator"], [data-testid="promoted-tweet"]',
          ),
        ).length > 0 ||
        article.closest('[data-testid="placementTracking"]')
      )
        continue;
      const social =
        article.querySelector('[data-testid="socialContext"]')?.textContent ??
        "";
      if (/\b(?:Promoted|Advertisement|reposted)\b/i.test(social)) continue;
      if (
        own(article.querySelectorAll("span")).some(
          (e) =>
            /^(Ad|Promoted)$/.test(e.textContent?.trim() ?? "") &&
            !e.closest('[data-testid="tweetText"]'),
        )
      )
        continue;
      const time = own(article.querySelectorAll("a:has(time)"))[0];
      const identity = canonical(time?.getAttribute("href") ?? null);
      if (!identity) continue;
      const textElement =
        own(article.querySelectorAll('[data-testid="tweetText"]')).find(
          (e) => !articleViews.some((view) => view.contains(e)),
        ) ?? null;
      const text = originalText(textElement);
      const richArticle = articleContent(article, quotes);
      const cover = own(
        article.querySelectorAll('[data-testid="article-cover-image"]'),
      )[0];
      const preview = cover?.nextElementSibling;
      const previewFields = preview
        ? [...preview.querySelectorAll('[dir="auto"]')]
        : [];
      const articlePreview = cover
        ? {
            title:
              originalText(previewFields[0] ?? null)?.slice(0, 2000) ?? null,
            text:
              originalText(previewFields[1] ?? null)?.slice(0, 16000) ?? null,
            limitation:
              "Rendered X Article preview only; title/excerpt may be clipped. Full article text was not collected.",
          }
        : undefined;
      const quotePosts: Post["quoted_posts"] = quotes
        .slice(0, 2)
        .map((quote) => {
          const protectedQuote = !!quote.querySelector(
            '[data-testid="icon-lock"], [aria-label="Protected account"]',
          );
          const target =
            [...quote.querySelectorAll("a[href]")]
              .map((a) => canonical(a.getAttribute("href")))
              .find(Boolean) ?? null;
          const quoteText = originalText(
            quote.querySelector('[data-testid="tweetText"]'),
          );
          const quoteArticle = protectedQuote
            ? undefined
            : articleContent(quote);
          return {
            ...(quoteArticle ? { article: quoteArticle } : {}),
            id: target?.id ?? null,
            url: target?.url ?? null,
            author: protectedQuote
              ? { username: null, display_name: null }
              : author(quote),
            text: protectedQuote ? null : (quoteText?.slice(0, 16000) ?? null),
            published_at: protectedQuote
              ? null
              : (quote.querySelector("time")?.getAttribute("datetime") ?? null),
            retrieved_at: new Date().toISOString(),
            evidence_links: protectedQuote
              ? []
              : [...quote.querySelectorAll('[data-testid="tweetText"] a[href]')]
                  .slice(0, 32)
                  .map((a) => ({
                    url: a.getAttribute("href")!,
                    display: originalText(a)?.slice(0, 300) ?? null,
                  })),
            truncated:
              (quoteText?.length ?? 0) > 16000 ||
              !!quote.querySelector(
                '[data-testid="tweet-text-show-more-link"]',
              ),
            unavailable:
              protectedQuote ||
              /^(This (?:post|tweet) is unavailable|This post is from a protected account)/i.test(
                quote.textContent?.trim() ?? "",
              ),
            media: protectedQuote
              ? []
              : media(quote, [
                  ...quote.querySelectorAll(
                    '[data-testid="twitterArticleReadView"]',
                  ),
                ]),
          };
        });
      const replyContext = own(
        article.querySelectorAll(
          '[data-testid="replyingTo"], a[aria-label^="Replying to"]',
        ),
      ).find((e) => !e.closest('[data-testid="tweetText"]'));
      const parentLink = replyContext
        ? replyContext.matches("a[href]")
          ? replyContext
          : replyContext.querySelector('a[href*="/status/"]')
        : null;
      const parent = canonical(parentLink?.getAttribute("href") ?? null);
      const count = (selector: string): string | null => {
        const element = own(article.querySelectorAll(selector))[0];
        if (!element) return null;
        const display =
          element
            .querySelector('[data-testid="app-text-transition-container"]')
            ?.textContent?.trim() ||
          element.textContent?.trim().replace(/\s*Views?$/i, "");
        if (display && /^[\d.,\s]+[KMB]?$/i.test(display)) return display;
        return (
          /^([\d.,]+[KMB]?)\s/i.exec(
            element.getAttribute("aria-label") ?? "",
          )?.[1] ?? null
        );
      };
      const links = own(
        article.querySelectorAll(
          '[data-testid="tweetText"] a[href], [data-testid="card.wrapper"] a[href]',
        ),
      )
        .filter((a) => /^https?:\/\//.test(a.getAttribute("href") ?? ""))
        .slice(0, 32)
        .map((a) => ({
          url: a.getAttribute("href")!,
          display: originalText(a)?.slice(0, 300) ?? null,
        }));
      posts.push({
        ...(richArticle ? { article: richArticle } : {}),
        ...(articlePreview ? { article_preview: articlePreview } : {}),
        ...identity,
        author: author(article),
        text: text?.slice(0, 16000) ?? null,
        published_at:
          time?.querySelector("time")?.getAttribute("datetime") ?? null,
        retrieved_at: new Date().toISOString(),
        parent_id: parent?.id ?? null,
        parent_evidence: parent
          ? {
              kind: "explicit_reply_link",
              source_url: source,
              label:
                replyContext?.textContent?.slice(0, 200) ||
                replyContext?.getAttribute("aria-label") ||
                "Replying to",
            }
          : null,
        quoted_posts: quotePosts,
        evidence_links: links,
        media: media(article, [...quotes, ...articleViews]),
        engagement: {
          replies: count('[data-testid="reply"]'),
          reposts: count('[data-testid="retweet"], [data-testid="unretweet"]'),
          likes: count('[data-testid="like"], [data-testid="unlike"]'),
          views: count('a[href$="/analytics"]'),
          bookmarks: count(
            '[data-testid="bookmark"], [data-testid="removeBookmark"]',
          ),
        },
        truncated:
          !!articlePreview ||
          (text?.length ?? 0) > 16000 ||
          own(
            article.querySelectorAll(
              '[data-testid="tweet-text-show-more-link"]',
            ),
          ).length > 0,
        unavailable: false,
        relation: "result",
        observed_on: source,
        traversal_depth: 0,
      });
    }
    const selected = primary
      ?.querySelector('[role="tab"][aria-selected="true"]')
      ?.textContent?.trim();
    const replySort = [
      ...(timeline?.querySelectorAll("button, [role=button]") ?? []),
    ]
      .map((e) => e.textContent?.trim())
      .find((text) =>
        [
          "Relevant",
          "Most relevant",
          "Latest",
          "Recent",
          "Most liked",
        ].includes(text ?? ""),
      );
    const ui = primary?.cloneNode(true) as Element | undefined;
    ui?.querySelectorAll("article").forEach((e) => e.remove());
    return {
      posts,
      protected_ids: protectedIds,
      boundary: !!boundary,
      timeline: timeline?.getAttribute("aria-label") ?? null,
      ordering: selected ?? replySort ?? "Website order (label unavailable)",
      empty: /No results for|hasn(?:’|')t posted|No posts yet/i.test(
        ui?.textContent ?? "",
      ),
    };
  }, sourceUrl);
  for (const post of frame.posts) {
    const checked = postUrl(post.url);
    if (checked.id !== post.id)
      throw new ReaderError(
        "extraction_error",
        "A displayed post ID did not match its permalink.",
      );
    post.evidence_links = post.evidence_links.flatMap((link) => {
      const url = safeEvidenceUrl(link.url);
      return url ? [{ ...link, url }] : [];
    });
    for (const article of [
      post.article,
      ...post.quoted_posts.map((q) => q.article),
    ])
      if (article)
        article.links = article.links.flatMap((link) => {
          const url = safeEvidenceUrl(link.url);
          return url ? [{ ...link, url }] : [];
        });
    for (const quote of post.quoted_posts)
      quote.evidence_links = quote.evidence_links.flatMap((link) => {
        const url = safeEvidenceUrl(link.url);
        return url ? [{ ...link, url }] : [];
      });
    for (const media of [
      ...post.media,
      ...(post.article?.media ?? []),
      ...post.quoted_posts.flatMap((q) => [
        ...q.media,
        ...(q.article?.media ?? []),
      ]),
    ]) {
      if (media.type === "image" && media.url && !allowedImage(media.url)) {
        media.url = null;
        media.limitation =
          "Unsupported image origin; pixels cannot be retrieved.";
      }
    }
  }
  return frame;
}

async function signature(page: Page): Promise<string> {
  return page
    .locator('[data-testid="primaryColumn"]')
    .evaluate((primary) =>
      [...primary.querySelectorAll('article[data-testid="tweet"]')]
        .map(
          (e) =>
            `${e.querySelector("a:has(time)")?.getAttribute("href")}:${e.querySelector('[data-testid="tweetText"]')?.textContent?.length}`,
        )
        .join("|"),
    );
}

async function awaitChange(page: Page, previous: string): Promise<void> {
  await page
    .waitForFunction(
      (old) => {
        const primary = document.querySelector('[data-testid="primaryColumn"]');
        const next = [
          ...(primary?.querySelectorAll('article[data-testid="tweet"]') ?? []),
        ]
          .map(
            (e) =>
              `${e.querySelector("a:has(time)")?.getAttribute("href")}:${e.querySelector('[data-testid="tweetText"]')?.textContent?.length}`,
          )
          .join("|");
        // Virtualized timelines can remove the old frame before rendering the next.
        return next.length > 0 && next !== old;
      },
      previous,
      { timeout: 1500, polling: "raf" },
    )
    .catch(() => {});
}

const replyControl =
  /^(?:Show (?:more replies|replies|additional replies|probable spam)|View (?:more replies|replies))(?:\s*\(\d+\))?$/i;

async function expand(
  page: Page,
  signal: AbortSignal,
  conversation: boolean,
  allowedIds: string[],
): Promise<number> {
  const primary = page.locator('[data-testid="primaryColumn"]');
  let clicked = 0;
  const textControls = primary.locator(
    '[data-testid="tweet-text-show-more-link"]',
  );
  for (
    let index = Math.min(await textControls.count(), 8) - 1;
    index >= 0;
    index--
  ) {
    checkSignal(signal);
    const control = textControls.nth(index);
    const safe = await control
      .evaluate((e, ids) => {
        const article = e.closest('article[data-testid="tweet"]');
        const href = article
          ?.querySelector("a:has(time)")
          ?.getAttribute("href");
        return (
          !!href &&
          ids.some((id) => href.endsWith(`/status/${id}`)) &&
          (e.tagName === "BUTTON" ||
            (e.getAttribute("role") === "button" && !e.hasAttribute("href")))
        );
      }, allowedIds)
      .catch(() => false);
    if (!safe || !(await control.isVisible())) continue;
    const before = await signature(page);
    await control.click({ timeout: 1500 }).then(
      () => {
        clicked++;
      },
      () => {},
    );
    await awaitChange(page, before);
  }
  if (conversation) {
    const controls = primary
      .locator('[aria-label="Timeline: Conversation"]')
      .getByRole("button", { name: replyControl });
    for (
      let index = Math.min(await controls.count(), 3) - 1;
      index >= 0;
      index--
    ) {
      checkSignal(signal);
      const control = controls.nth(index);
      const safe = await control
        .evaluate((e) => {
          const timeline = e.closest('[aria-label="Timeline: Conversation"]');
          const boundary = [
            ...(timeline?.querySelectorAll('h1, h2, h3, [role="heading"]') ??
              []),
          ].find(
            (node) =>
              !node.closest("article") &&
              /^(Discover more|More for you|You might like|Recommended|Who to follow|Related posts)$/i.test(
                node.textContent?.trim() ?? "",
              ),
          );
          return (
            !e.closest('article [data-testid="tweetText"]') &&
            !e.hasAttribute("href") &&
            !(
              boundary &&
              boundary.compareDocumentPosition(e) &
                Node.DOCUMENT_POSITION_FOLLOWING
            )
          );
        })
        .catch(() => false);
      if (!safe || !(await control.isVisible())) continue;
      const before = await signature(page);
      await control.click({ timeout: 1500 }).then(
        () => {
          clicked++;
        },
        () => {},
      );
      await awaitChange(page, before);
    }
  }
  return clicked;
}

async function collectPageOnce(
  page: Page,
  url: string,
  kind: PageKind,
  signal: AbortSignal,
  onPost: (post: Post) => void,
  options: {
    depth: number;
    maxDepth: number;
    sort?: "latest" | "top";
    onProgress?: (progress: { ordering: string; scrolls: number }) => void;
  },
): Promise<{
  ordering: string;
  stop_reason: StopReason;
  scrolls: number;
  unexpanded: boolean;
}> {
  await navigate(page, url, signal);
  const isConversation = kind === "post" || kind === "thread";
  const focal = isConversation ? postUrl(url).id : null;
  await page
    .waitForFunction(
      () => {
        const primary = document.querySelector('[data-testid="primaryColumn"]');
        return (
          !!primary?.querySelector(
            'article[data-testid="tweet"], [data-testid="error-detail"]',
          ) ||
          /No results for|hasn(?:’|')t posted|No posts yet/.test(
            primary?.textContent ?? "",
          )
        );
      },
      undefined,
      { timeout: Math.min(12000, config.navigationMs) },
    )
    .catch(() => {});
  const initialState = await pageState(page);
  if (initialState !== "ready")
    throw new ReaderError(initialState, actionFor(initialState));
  await hydrateArticles(page, signal);
  let foundFocal = false;
  let ordering = "Website order (label unavailable)";
  let scrolls = 0;
  let stop: StopReason = "scroll_budget";
  const seen = new Set<string>();
  const ancestors = new Set<string>();
  let idle = 0;
  const consume = async (): Promise<Frame> => {
    checkSignal(signal);
    const state = await pageState(page);
    if (state !== "ready") throw new ReaderError(state, actionFor(state));
    if (!sameReadingTarget(url, page.url()))
      throw new ReaderError(
        "unexpected_redirect",
        "The page changed during extraction. No substitute query, sort or page was collected.",
      );
    const frame = await extractVisible(page, url);
    if (focal && frame.protected_ids.includes(focal))
      throw new ReaderError(
        "protected_content",
        actionFor("protected_content"),
      );
    if (isConversation && frame.timeline !== "Timeline: Conversation")
      throw new ReaderError(
        "extraction_error",
        "The page did not expose a recognized Conversation timeline. No unrelated feed was collected.",
      );
    if (kind === "search" && frame.ordering.toLowerCase() !== options.sort)
      throw new ReaderError(
        "unsupported_sort",
        "X did not select the requested Top/Latest tab. No alternate sort was substituted.",
      );
    ordering =
      kind === "user"
        ? `${frame.ordering}; pinned posts may precede recent posts`
        : frame.ordering;
    options.onProgress?.({ ordering, scrolls });
    const focalIndex = frame.posts.findIndex((p) => p.id === focal);
    if (focalIndex >= 0)
      for (const post of frame.posts.slice(0, focalIndex))
        ancestors.add(post.id);
    if (focalIndex >= 0) foundFocal = true;
    if (isConversation && !foundFocal) return frame;
    for (const post of frame.posts) {
      checkSignal(signal);
      if (seen.size >= 100 && !seen.has(post.id)) break;
      if (kind === "post" && post.id !== focal) continue;
      if (isConversation) {
        post.relation =
          post.id === focal
            ? "focal"
            : ancestors.has(post.id)
              ? "ancestor_context"
              : "conversation";
        post.traversal_depth =
          post.relation === "conversation" ? options.depth + 1 : options.depth;
        if (
          post.relation === "conversation" &&
          options.depth >= options.maxDepth
        )
          continue;
      }
      seen.add(post.id);
      onPost(post);
    }
    return frame;
  };
  for (let step = 0; step <= config.scrolls; step++) {
    const frame = await consume();
    if (isConversation && !foundFocal)
      throw new ReaderError(
        "extraction_error",
        "The exact requested post was not found in the Conversation timeline.",
      );
    if (!frame.posts.length && !frame.empty)
      throw new ReaderError(
        "extraction_error",
        "No posts or explicit empty-results state could be recognized.",
      );
    const expanded = await expand(
      page,
      signal,
      kind === "thread" && options.depth < options.maxDepth,
      frame.posts.map((post) => post.id),
    );
    if (expanded) {
      await hydrateArticles(page, signal);
      await consume();
    }
    if (kind === "post") {
      stop = "requested_post";
      break;
    }
    if (isConversation && options.depth >= options.maxDepth) {
      stop = "depth_budget";
      break;
    }
    if (frame.boundary || frame.empty) {
      stop =
        frame.empty && !seen.size
          ? "empty_results"
          : "no_further_visible_content";
      break;
    }
    if (seen.size >= 100) {
      stop = "configured_limit";
      break;
    }
    if (step === config.scrolls) break;
    const before = await signature(page);
    const moved = await page.evaluate(() => {
      const old = window.scrollY;
      window.scrollBy(0, Math.max(500, window.innerHeight * 0.8));
      return window.scrollY !== old;
    });
    scrolls++;
    options.onProgress?.({ ordering, scrolls });
    await awaitChange(page, before);
    const changed = before !== (await signature(page));
    idle = !moved && !changed && !expanded ? idle + 1 : 0;
    if (idle >= 2) {
      await consume();
      stop = "no_further_visible_content";
      break;
    }
  }
  const unexpanded =
    (await page
      .locator('[data-testid="primaryColumn"]')
      .getByRole("button", { name: replyControl })
      .count()) > 0;
  return {
    ordering,
    stop_reason: stop,
    scrolls,
    unexpanded,
  };
}

/** Article tables, formulas and references can load only after entering the viewport. */
async function hydrateArticles(page: Page, signal: AbortSignal): Promise<void> {
  const views = page.locator(
    '[data-testid="primaryColumn"] [data-testid="twitterArticleReadView"]',
  );
  if (!(await views.count())) return;
  const scroll = await page.evaluate(() => window.scrollY);
  let missing = 0;
  try {
    await views
      .first()
      .locator(
        '[data-testid="longformRichTextComponent"], [data-testid="twitterArticleRichTextView"]',
      )
      .first()
      .waitFor({ state: "attached", timeout: 2000 })
      .catch(() => {});
    const sections = views.locator('section[data-block="true"]');
    const count = Math.min(await sections.count(), 64);
    let attempts = 0;
    for (let index = 0; index < count && attempts < 16; index++) {
      checkSignal(signal);
      const section = sections.nth(index);
      const empty = await section.evaluate(
        (e) =>
          !e.textContent?.trim() && !e.querySelector('img,[role="separator"]'),
      );
      if (!empty) continue;
      attempts++;
      const state = await pageState(page);
      if (state !== "ready") throw new ReaderError(state, actionFor(state));
      try {
        await section.scrollIntoViewIfNeeded({ timeout: 1000 });
        await section
          .locator('table, math, img, a[href], [role="separator"]')
          .first()
          .waitFor({ state: "attached", timeout: 1200 });
      } catch {
        checkSignal(signal);
        missing++;
      }
    }
  } finally {
    await page.evaluate((y) => window.scrollTo(0, y), scroll).catch(() => {});
  }
  if (missing)
    logEvent({
      level: "warn",
      event: "article_embeds_unavailable",
      count: missing,
      message:
        "Some Article embeds did not render within the loading budget; extraction reports missing blocks.",
    });
}

/** Retry only before emitting evidence; never mix two snapshots after a partial read. */
export async function collectPage(
  ...args: Parameters<typeof collectPageOnce>
): ReturnType<typeof collectPageOnce> {
  const [page, url, kind, signal, onPost, options] = args;
  let emitted = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await collectPageOnce(
        page,
        url,
        kind,
        signal,
        (post) => {
          emitted = true;
          onPost(post);
        },
        options,
      );
    } catch (error) {
      checkSignal(signal);
      const failure =
        error instanceof ReaderError
          ? error
          : new ReaderError(
              "extraction_error",
              "The rendered page changed or could not be read. Retry the same request; if it persists, the DOM reader needs updating. No alternate query or ordering was used.",
            );
      if (
        emitted ||
        attempt === 2 ||
        !["navigation_error", "extraction_error"].includes(failure.code)
      )
        throw failure;
      logEvent({
        level: "warn",
        event: "retrieval_retry",
        kind,
        attempt,
        code: failure.code,
      });
      await page.waitForTimeout(500);
    }
  }
  throw new ReaderError("extraction_error", "Retrieval attempts exhausted.");
}

export async function screenshotMedia(
  page: Page,
  reference: MediaRef,
  signal: AbortSignal,
): Promise<{
  bytes: Buffer;
  width: number;
  height: number;
  source: "cdn_image" | "rendered_crop";
  limitations: string[];
}> {
  let verified = false;
  if (sameReadingTarget(reference.post_url, page.url())) {
    const state = await pageState(page);
    if (state !== "ready") throw new ReaderError(state, actionFor(state));
    const frame = await extractVisible(page, reference.post_url);
    verified = frame.posts.some(
      (post) =>
        post.id === reference.post_id &&
        [
          ...post.media,
          ...(post.article?.media ?? []),
          ...post.quoted_posts.flatMap((q) => [
            ...q.media,
            ...(q.article?.media ?? []),
          ]),
        ].some((media) => media.url === reference.src),
    );
  } else
    await collectPage(
      page,
      reference.post_url,
      "post",
      signal,
      (post) => {
        if (
          post.id === reference.post_id &&
          [
            ...post.media,
            ...(post.article?.media ?? []),
            ...post.quoted_posts.flatMap((q) => [
              ...q.media,
              ...(q.article?.media ?? []),
            ]),
          ].some((media) => media.url === reference.src)
        )
          verified = true;
      },
      { depth: 0, maxDepth: 0 },
    );
  if (!verified)
    throw new ReaderError(
      "media_unavailable",
      "That image is no longer visible on the retrieved public post. Retrieve the post again.",
    );
  // Request a larger version of this verified attachment, never an arbitrary URL.
  // Drawing its natural dimensions avoids the timeline's object-fit cropping.
  const fullSize = new URL(reference.src);
  fullSize.searchParams.set("name", "large");
  const decoded = await page.evaluate(async (src) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.src = src;
    const timer = setTimeout(() => {
      image.src = "";
    }, 8000);
    try {
      await image.decode();
      if (!image.naturalWidth || !image.naturalHeight) return null;
      const scale = Math.min(
        1,
        2048 / image.naturalWidth,
        2048 / image.naturalHeight,
        Math.sqrt(4_000_000 / (image.naturalWidth * image.naturalHeight)),
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.floor(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return {
        data: canvas.toDataURL("image/png").split(",")[1]!,
        width: canvas.width,
        height: canvas.height,
        resized: scale < 1,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }, fullSize.href);
  checkSignal(signal);
  if (decoded) {
    const bytes = Buffer.from(decoded.data, "base64");
    if (bytes.length <= 4 * 1024 * 1024)
      return {
        bytes,
        width: decoded.width,
        height: decoded.height,
        source: "cdn_image",
        limitations: [
          "X's large image variant may have lower resolution than the uploaded original.",
          ...(decoded.resized
            ? [
                "Image reduced to the 2048px / 4 million pixel budget; small text may be unreadable.",
              ]
            : []),
        ],
      };
  }
  logEvent({
    level: "warn",
    event: "media_capture_fallback",
    post_id: reference.post_id,
    message:
      "Full attachment pixels unavailable or too large; returning the rendered crop.",
  });
  const images = page.locator(
    '[data-testid="primaryColumn"] article[data-testid="tweet"] [data-testid="tweetPhoto"] img',
  );
  for (let i = 0; i < (await images.count()); i++) {
    const image = images.nth(i);
    if (
      !(await image.evaluate(
        (img, src) =>
          (img as HTMLImageElement).currentSrc === src ||
          img.getAttribute("src") === src,
        reference.src,
      ))
    )
      continue;
    await image.scrollIntoViewIfNeeded({ timeout: 3000 });
    await image
      .evaluate(async (img) => {
        await (img as HTMLImageElement).decode();
      })
      .catch(() => {
        throw new ReaderError(
          "media_unavailable",
          "The displayed image failed to load.",
        );
      });
    const bounds = await image.boundingBox();
    if (
      !bounds ||
      bounds.width < 1 ||
      bounds.height < 1 ||
      bounds.width > 2048 ||
      bounds.height > 2048 ||
      bounds.width * bounds.height > 4_000_000
    )
      throw new ReaderError(
        "media_too_large",
        "Rendered image exceeds the 2048px / 4 million pixel limit.",
      );
    checkSignal(signal);
    const bytes = await image.screenshot({
      type: "png",
      timeout: 5000,
      animations: "disabled",
    });
    return {
      bytes,
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      source: "rendered_crop",
      limitations: [
        "Full attachment pixels could not be captured. This rendered crop may omit text or other image content.",
      ],
    };
  }
  throw new ReaderError(
    "media_unavailable",
    "The discovered image is no longer rendered.",
  );
}
