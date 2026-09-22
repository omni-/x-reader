// Entirely synthetic pages. Selectors mirror inspected X markup; no captured account data.
import { chromium } from "playwright";

export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9c8AAAAASUVORK5CYII=",
  "base64",
);
export const textImage = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1100"><rect width="800" height="1100" fill="white"/><g fill="black" font-family="sans-serif" font-size="30"><text x="50" y="70">COMMUNITY WORKSHOP</text><text x="50" y="150">Saturday, October 3</text><text x="50" y="240">Morning</text><text x="440" y="240">Afternoon</text><text x="50" y="300">09:00 Registration</text><text x="440" y="300">13:00 Practice</text><text x="50" y="360">10:00 Introduction</text><text x="440" y="360">15:00 Questions</text><text x="50" y="1000">Bring a notebook.</text></g></svg>`;
export const ordinaryImage = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="skyblue"/><circle cx="520" cy="80" r="45" fill="gold"/><path d="M0 320 170 120 330 320 440 180 640 320Z" fill="forestgreen"/><path d="M0 320H640V480H0Z" fill="steelblue"/></svg>`;
const escape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export function card(id, handle, text, options = {}) {
  const media = options.image
    ? `<div data-testid="tweetPhoto"><img width="96" height="72" style="object-fit:cover" alt="${options.image === true ? "Synthetic chart" : "Image"}" src="https://pbs.twimg.com/media/${options.image === true ? "fixture" : options.image}?format=png&name=small"></div>`
    : "";
  const quote = options.quote
    ? `<span>Quote</span><div role="link"><div data-testid="User-Name"><span>Quoted Author</span><span>@quoter</span></div><time datetime="2026-09-01T00:00:00Z"></time><div data-testid="tweetText">This is quoted evidence.</div><a href="/quoter/status/900/photo/1"><div data-testid="tweetPhoto"><img width="96" height="72" alt="Quoted screenshot" src="https://pbs.twimg.com/media/quote_fixture?format=png&name=small"></div></a></div>`
    : "";
  const textNode =
    text === null
      ? ""
      : `<div data-testid="tweetText">${escape(text)}${options.emoji ? '<img alt="🚀" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E">' : ""}${options.link ? '<a href="https://example.org/evidence"> evidence</a>' : ""}</div>`;
  return `<article data-testid="tweet" ${options.ad ? 'data-ad="true"' : ""}>
  ${options.ad ? '<div data-testid="promotedIndicator">Ad</div>' : ""}
  <div data-testid="User-Name"><a href="/${handle}">${escape(options.display ?? handle)}</a><span>@${handle}</span>${options.protected ? '<svg aria-label="Protected account"></svg>' : ""}</div>
  <a href="/${handle}/status/${id}"><time datetime="2026-09-01T01:00:00Z">Sep 1</time></a>
  ${options.parent ? `<div data-testid="replyingTo">Replying to <a href="/root/status/${options.parent}">a specific post</a></div>` : options.mention ? '<div>Replying to <a href="/root">@root</a></div>' : ""}
  ${textNode}${media}${quote}
  ${options.long ? `<button data-testid="tweet-text-show-more-link" onclick="this.previousElementSibling.textContent='Full long text'+String.fromCharCode(10)+'second line'; this.remove()">Show more</button>` : ""}
  ${options.missingCounts ? "" : '<button data-testid="reply" aria-label="2 Replies. Reply"><span data-testid="app-text-transition-container">2</span></button><button data-testid="like" aria-label="1200 Likes. Like"><span data-testid="app-text-transition-container">1.2K</span></button><button data-testid="bookmark" aria-label="Bookmark"></button>'}
  </article>`;
}

export function wrap(
  content,
  {
    timeline = "Timeline: Conversation",
    selected,
    script = "",
    ui = "",
    auth = true,
  } = {},
) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>body{margin:0}main{max-width:650px}article{padding:12px;border:1px solid #ccc;min-height:110px}[data-testid=tweetText]{white-space:pre-wrap}button{min-width:12px;min-height:12px}img{object-fit:fill}#space{height:900px}</style></head><body>${auth ? '<button data-testid="SideNav_AccountSwitcher_Button">Account</button>' : '<a href="/i/flow/login">Log in</a>'}<main data-testid="primaryColumn">${selected ? `<a role="tab" aria-selected="true">${selected}</a>` : ""}${ui}<section aria-label="${timeline}"><h2>Conversation</h2><button>Relevant</button>${content}</section></main><script>${script}</script></body></html>`;
}

// Reduced, synthetic reproduction of the inspected nested X Article markup.
// The long body catches the old 16K post-text cap without storing the source article.
export function articleCard(id = "2101034933284417614") {
  const paragraphs = Array.from(
    { length: 90 },
    (_, index) =>
      `<div class="longform-unstyled" data-block="true"><div><span data-text="true">Paragraph ${index + 1}. ${"Rendered Article text stays separate from post text and image interpretation. ".repeat(4)}</span></div></div>`,
  ).join("");
  const images = Array.from(
    { length: 7 },
    (_, index) =>
      `<section data-block="true"><div data-testid="tweetPhoto"><img width="96" height="72" alt="Image" src="https://pbs.twimg.com/media/article_${index}?format=png&amp;name=small"></div></section>`,
  ).join("");
  const content = `<article data-testid="twitterArticleReadView">
    <div data-testid="twitter-article-title">The Inference Gap</div>
    <button>16 replies</button>
    <div data-testid="twitterArticleRichTextView"><div data-testid="longformRichTextComponent"><div data-contents="true">
    <div data-block="true">Access to frontier models no longer guarantees access to the inference regime that can reliably reproduce frontier model capabilities.</div>
    <section data-block="true"><div role="separator"></div></section>
    <h1 data-block="true">What was measured</h1>
    <div data-block="true">First line<br>second line <img alt="🚀" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E"></div>
    <ol><li data-block="true">First finding</li><li data-block="true">Second finding</li></ol>
    <blockquote data-block="true">A quoted passage.</blockquote>
    <pre data-block="true">const reading = true;</pre>
    <div data-block="true"><a href="https://example.org/source">Evidence</a> and <a href="/writer/status/123">related post</a><a href="javascript:alert(1)">unsafe</a></div>
    ${paragraphs}${images}
    <h2 data-block="true">Conclusion</h2><div data-block="true">The final paragraph is present.</div>
    </div></div></div>
    <a href="/i/premium_sign_up">Upgrade to Premium</a>
    </article>`;
  return card(id, "Lon", null, { display: "Lon Lundgren" }).replace(
    "</article>",
    `${content}</article>`,
  );
}

export function fixtureHtml(url) {
  const target = new URL(url);
  const id = /\/status\/(\d+)/.exec(target.pathname)?.[1];
  if (id === "2101034933284417614") return wrap(articleCard());
  if (id === "910")
    return wrap(
      card(id, "text_image", "Workshop handout", { image: "text_image" }),
    );
  if (id === "920")
    return wrap(card(id, "scene", null, { image: "ordinary_image" }));
  if (id === "930")
    return wrap(
      card(id, "broken", "The source text remains available", {
        image: "broken_image",
      }),
    );
  if (id === "940")
    return wrap(
      Array.from({ length: 5 }, (_, index) =>
        card(String(940 + index), "scene", "Image reply", {
          image: "ordinary_image",
        }),
      ).join("") + "<h2>Discover more</h2>",
    );
  if (/^94[1-4]$/.test(id ?? ""))
    return wrap(card(id, "scene", "Image reply", { image: "ordinary_image" }));
  if (id === "666") return wrap("", { auth: false });
  if (id === "667") return wrap("", { ui: "<div>Rate limit exceeded</div>" });
  if (id === "668") return wrap("", { ui: "<div>Verify you are human</div>" });
  if (id === "669")
    return wrap("", { ui: "<div>This post is unavailable</div>" });
  if (id === "670")
    return wrap("", { ui: "<div>These posts are protected</div>" });
  if (id === "671")
    return wrap("", { ui: "<div>Your account is suspended</div>" });
  if (target.pathname === "/home") return wrap("");
  if (target.pathname === "/search") {
    const sort = target.searchParams.get("f") === "live" ? "Latest" : "Top";
    if (target.searchParams.get("q") === "empty")
      return wrap("", {
        timeline: "Timeline: Search timeline",
        selected: sort,
        ui: "<div>No results for empty</div>",
      });
    return wrap(
      Array.from({ length: 8 }, (_, i) =>
        card(String(800 + i), "finder", `Search evidence ${i}`),
      ).join(""),
      {
        timeline: "Timeline: Search timeline",
        selected:
          target.searchParams.get("q") === "wrong-sort" ? "People" : sort,
      },
    );
  }
  if (!id)
    return wrap(
      card("100", "root", "Public user post") +
        card("200", "alice", "A repost", { protected: true }),
      { timeline: "Timeline: User posts", selected: "Posts" },
    );
  if (id === "700") {
    return wrap(
      card("700", "root", "First frame") +
        card("701", "alice", "This disappears after scrolling") +
        '<div id="space"></div>',
      {
        script: `window.addEventListener('scroll',()=>{ if(window.done)return;window.done=true;document.querySelector('section').innerHTML=${JSON.stringify(card("701", "alice", "Duplicate from first frame") + card("702", "bob", "Only appears in second frame") + "<h2>Discover more</h2>" + card("799", "stranger", "Unrelated recommendation"))}; });`,
      },
    );
  }
  if (id === "710")
    return wrap(
      card("710", "root", "Collected before the rate limit") +
        card("711", "alice", "Also collected") +
        '<div id="space"></div>',
      {
        script:
          "window.addEventListener('scroll',()=>{document.querySelector('main').innerHTML='<div>Rate limit exceeded</div>';},{once:true});",
      },
    );
  if (id === "750")
    return wrap(
      card("750", "root", "Collected before virtualization") +
        card("751", "alice", "Old frame") +
        '<div id="space"></div>',
      {
        script: `window.addEventListener('scroll',()=>{const timeline=document.querySelector('section');timeline.innerHTML='<div role="progressbar">Loading</div>';setTimeout(()=>{timeline.innerHTML=${JSON.stringify(card("752", "bob", "New frame after an empty frame") + "<h2>Discover more</h2>" + card("799", "stranger", "Recommendation"))}},80);},{once:true});`,
      },
    );
  if (id === "760") {
    const reveal = `this.closest('section').insertAdjacentHTML('afterbegin',${JSON.stringify(card("759", "ancestor", "Context rendered after the focal post"))});this.remove()`;
    return wrap(
      card("760", "root", "Initially rendered focal").replace(
        "</article>",
        `<button data-testid="tweet-text-show-more-link" onclick="${escape(reveal)}">Show more</button></article>`,
      ),
    );
  }
  if (id === "720")
    return wrap(
      card("720", "private", "Secret protected text", { protected: true }),
    );
  if (id === "730")
    return wrap(card("730", "root", "Known post-shaped content"), {
      timeline: "Timeline: Home",
    });
  if (id === "100")
    return wrap(
      card("100", "root", "Original claim\nwith original formatting", {
        emoji: true,
        link: true,
      }) +
        card("200", "alice", "A firsthand disagreement", { parent: "100" }) +
        card("300", "bob", "A correction with a quote", {
          quote: true,
          mention: true,
        }) +
        card("400", "carol", null, { image: true, missingCounts: true }) +
        card("450", "longform", "Full long…", { long: true }) +
        card("500", "advertiser", "Advertisement", { ad: true }) +
        card("550", "private", "Protected content", { protected: true }) +
        '<div id="expansion"><button onclick="this.parentElement.innerHTML=\'&lt;div&gt;expanded&lt;/div&gt;\'">Show more replies</button></div>' +
        "<h2>Discover more</h2>" +
        card("999", "stranger", "Unrelated recommendation"),
    );
  if (id === "200")
    return wrap(
      card("100", "root", "Original claim\nwith original formatting", {
        emoji: true,
        link: true,
      }) +
        card("200", "alice", "A firsthand disagreement", { parent: "100" }) +
        card("201", "dan", "Nested supporting evidence", { parent: "200" }) +
        card("202", "alice", "Author follow-up", { parent: "200" }),
    );
  if (id === "300")
    return wrap(
      card("100", "root", "Original claim") +
        card("300", "bob", "A correction with a quote", {
          quote: true,
          mention: true,
        }) +
        card("301", "eve", "Nested disagreement", { parent: "300" }),
    );
  if (id === "400")
    return wrap(
      card("400", "carol", null, { image: true, missingCounts: true }),
    );
  if (id === "450")
    return wrap(card("450", "longform", "Full long…", { long: true }));
  return wrap(card(id, "nested", "A deeper branch"));
}

export class FixtureBrowser {
  visited = [];
  latched = [];
  constructor(options = {}) {
    this.options = options;
  }
  async run(work, parentSignal) {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 700 },
    });
    const signal = AbortSignal.any([
      parentSignal ?? new AbortController().signal,
      AbortSignal.timeout(30000),
    ]);
    const abort = () => {
      void browser.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (url.startsWith("https://pbs.twimg.com/media/")) {
        if (url.includes("broken_image")) {
          await route.fulfill({ status: 404, body: "Missing image" });
          return;
        }
        const svg = url.includes("text_image")
          ? textImage
          : url.includes("ordinary_image")
            ? ordinaryImage
            : null;
        await route.fulfill({
          body: svg ?? PNG,
          contentType: svg ? "image/svg+xml" : "image/png",
          headers: { "Access-Control-Allow-Origin": "*" },
        });
        return;
      }
      if (!url.startsWith("https://x.com/")) {
        await route.abort();
        return;
      }
      this.visited.push(url);
      await route.fulfill({ contentType: "text/html", body: fixtureHtml(url) });
    });
    try {
      await this.options.onPage?.(page);
      return await work(page, signal);
    } finally {
      signal.removeEventListener("abort", abort);
      await browser.close();
      await this.options.onClose?.();
    }
  }
  async status() {
    return {
      ready: true,
      state: "synthetic_fixture",
      checked_at: new Date().toISOString(),
      browser_available: true,
      dedicated_profile_exists: false,
      action: null,
    };
  }
  latch(reason) {
    this.latched.push(reason);
  }
  async close() {}
}
