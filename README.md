# x-reader

A personal, read-only MCP server for researching public X conversations with your own manually authenticated browser. The server retrieves evidence; ChatGPT or another calling model analyzes it. No X API, scraping service, LLM API, dashboard, or posting tools are used.

**Account risk:** X's [automation rules](https://help.x.com/en/rules-and-policies/x-automation) prohibit non-API website automation and warn that it can lead to permanent suspension. Read-only behavior, throttling, and using a separate account do not establish permission or guarantee safety. This implementation stops on access barriers; it does not bypass them.

## Windows / PowerShell setup

Use [Node.js 24 LTS](https://nodejs.org/en/about/previous-releases) and installed Microsoft Edge. Playwright controls Edge for reads. Login opens **normal Edge without automation attached** for manual sign-in. Other platforms use Playwright Chromium and have not been live-tested.

Clone or download this repository, then open PowerShell. Replace `C:\path\to\x-reader` in the examples with your checkout's absolute path.

```powershell
Set-Location 'C:\path\to\x-reader'
npm ci
npm run browser:install
npm run build
npm run login
# Sign in yourself. Close the dedicated browser normally before continuing.
npm run diagnostics
npm test
npm run check
npm run serve:http
```

`browser:install` installs Chromium for isolated tests and the non-Windows fallback; Windows serving uses Edge. `diagnostics` returns non-secret readiness and exits with code 2 when not ready. A successful session check means authenticated navigation was visible, not that every post will be accessible.

All commands resolve `.local/x-browser-profile/` relative to the installation, regardless of the working directory. No normal browser profile is read or copied. Login never inspects credential entry or verification screens. If the dedicated session already works, reuse it. If X asks for login or verification, stop requests, run `npm run login`, complete it yourself, close the browser, and check diagnostics again. Do not send credentials, codes, cookies, or profiles to a model.

An app lock serializes profile ownership across processes. An Edge `UserDataDir` policy that could override the profile is refused. Close other x-reader processes normally if a profile lock is reported. Do not delete browser lock files to force access.

## Commands

| Command                   | Purpose                                                                        |
| ------------------------- | ------------------------------------------------------------------------------ |
| `npm ci`                  | Install the exact lockfile dependencies                                        |
| `npm run browser:install` | Install Playwright Chromium                                                    |
| `npm run build`           | Compile TypeScript into `dist/`                                                |
| `npm run login`           | Open the dedicated visible browser for manual login                            |
| `npm run diagnostics`     | Verify browser availability and authenticated navigation                       |
| `npm run serve:http`      | Serve Streamable HTTP at `http://127.0.0.1:8765/mcp`                           |
| `npm run serve:stdio`     | Serve stdio for local clients                                                  |
| `npm run clear-cache`     | Invalidate in-memory cursors/media before each server's next call              |
| `npm run reset-profile`   | Interactively require `RESET x-reader`, then delete only the dedicated profile |
| `npm test`                | Build, deterministic browser tests, and real MCP client tests                  |
| `npm run check`           | Type checking and Prettier formatting checks                                   |
| `npm run format`          | Format this project's source, tests, scripts and docs                          |

Deleting a local profile does **not** guarantee revocation of the remote X or Google session. Use the services' account security controls for revocation. Reset is never exposed over MCP. Ctrl+C closes the server and any browser it owns.

For a local MCP client, configure its executable as `node` and arguments as the absolute path to your built CLI, for example `C:\path\to\x-reader\dist\cli.js`, followed by `stdio`. Use that client's own documented configuration format. Avoid using npm as the subprocess command: npm's banner is not MCP protocol data. Both transports use the same tools and reader.

## Connect ChatGPT with Secure MCP Tunnel

Documentation checked September 20, 2026 UTC. This is a private developer-mode MCP connection, requiring no custom UI or plugin manifest.

1. Confirm account access. OpenAI lists Pro, Plus, Business, Enterprise and Education web accounts for [developer mode](https://developers.openai.com/api/docs/guides/developer-mode); workspace policy can still limit access. Check availability in your own account and enable it under Settings → Security and login.
2. Open [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels). Creating/editing needs **Tunnels Read + Manage**; running/selecting a tunnel needs **Read + Use**. Associate it with the intended Platform organization and ChatGPT workspace. Personal accounts use their personal Platform organization. These are separate from ChatGPT permissions. [Official tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
3. Obtain the supported Windows client from that page or the [official latest release](https://github.com/openai/tunnel-client/releases/latest). Extract the full Windows amd64 ZIP to `.local/tunnel-client/`. Check its SHA256 against the release's `SHA256SUMS.txt`. Install this client separately; the repository does not include it.
4. Provision a **runtime** API key locally as `CONTROL_PLANE_API_KEY`, using your normal secret-management method. The key's principal needs Read + Use. This authenticates the tunnel; x-reader makes no model API calls. Do not put the key in this repository, CLI arguments, or chat. Keep your browser credentials separate. [Official client onboarding](https://github.com/openai/tunnel-client/blob/master/docs/onboarding.md)

For first-time setup, keep `npm run serve:http` running in the first terminal. In a second PowerShell terminal, with the runtime key already provided locally:

```powershell
Set-Location 'C:\path\to\x-reader'
$tc = '.\.local\tunnel-client\tunnel-client.exe'
& $tc --version
& $tc help quickstart
$env:CONTROL_PLANE_TUNNEL_ID = 'tunnel_REPLACE_WITH_YOUR_32_LOWERCASE_HEX_ID'
& $tc init --sample sample_mcp_remote_no_auth --profile x-reader --tunnel-id $env:CONTROL_PLANE_TUNNEL_ID --mcp-server-url http://127.0.0.1:8765/mcp
& $tc doctor --profile x-reader --explain
& $tc run --profile x-reader
```

After initializing the profile, stop the setup server and use **`npm start`** for normal local startup. This builds x-reader, starts its loopback HTTP server, and launches the bundled local `.local/tunnel-client/tunnel-client.exe run --profile x-reader`. Keep the runtime key in the environment. `TUNNEL_CLIENT_PROFILE` selects another already-initialized profile. The command overrides the tunnel HTTP target with the actual loopback server URL and binds the tunnel health UI to a random loopback port. Ctrl+C stops both; a tunnel exit also stops the HTTP server. Missing binaries, missing runtime credentials, and an occupied server port fail with actionable messages. The official tunnel binary remains a separately installed local prerequisite; no secrets or binaries are committed.

These flags and the no-auth HTTP sample were checked against the official Windows client v0.0.14. Check its help when using a newer version. The generated client profile references the environment variable; no hand-written tunnel config is needed. Use `doctor` again when reusing an existing profile instead of overwriting it.

When the client is healthy, open [ChatGPT Plugins](https://chatgpt.com/plugins), select the plus button, name the connection **x-reader**, choose **Tunnel**, and select the tunnel or supply its ID. The local MCP application uses No Authentication behind the authenticated tunnel. Review the six discovered tools and enable the connection in a conversation. Current [OpenAI connection instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt) supersede older custom-app UI labels.

Keep both the HTTP server and tunnel client running while using the connection. If the tunnel is missing, verify workspace association and Read + Use permission. If your account lacks these features, use a local stdio client while resolving access. No public endpoint or inbound firewall rule is needed, and x-reader will not bind to a public interface. Do not substitute a public unauthenticated tunnel.

The recorded verification does not include authenticated tunnel checks or a ChatGPT invocation. Verify `doctor` readiness and a ChatGPT tool call with your own account; see [VERIFICATION.md](VERIFICATION.md) for the checks already performed.

## Tools and evidence

| Tool             | Input                                                                      |
| ---------------- | -------------------------------------------------------------------------- |
| `get_post`       | `url`                                                                      |
| `get_thread`     | `url`, `max_posts=40` (1–100), `max_depth=2` (0–3), optional `cursor`      |
| `search_x`       | `query`, `limit=20` (1–100), `sort="latest"` or `"top"`, optional `cursor` |
| `get_user_posts` | `username`, `limit=20` (1–100), optional `cursor`                          |
| `get_status`     | No arguments                                                               |
| `read_media`     | A `media_id` returned by a retrieved post                                  |

Search results include `search: { query, sort }` using the exact submitted text, including native X operators and whitespace. A confirmed empty website state returns `posts: []` with `stop_reason: "empty_results"`; authentication, rate-limit, navigation and extraction failures never count as confirmed empty results.

Results live in `structuredContent.data`; failures use `isError=true` and `structuredContent.error`. Text content is a short status, not another copy of the dataset. `read_media` returns MCP PNG image content (up to 4 MiB, 2048px per side and 4 million pixels), obtained from the rendered image on the verified post. It never accepts a URL or local filename. X may crop that rendered image. Videos remain metadata-only.

X Article cards include separate `article_preview` title/excerpt fields and `truncated: true`; they are not full article retrievals. Ordinary post text and quoted posts remain separate.

Posts include canonical URLs, authors, original text, timestamps, displayed engagement strings, evidence links, separate quoted posts, media references, and truncation/unavailability flags. Unknown fields are null, including unknown reply parents. External evidence links are returned without opening those sites. Quotes lacking a visible permalink retain a null ID/URL; x-reader does not invent one.

`get_thread` keeps the exact linked post as `focal_id`, even for a nested reply. It gathers available ancestor context, then expands observed conversation posts in breadth-first order across authors. Its depth budget counts **page-expansion hops**, because the website often does not expose exact parent edges. It does not infer parents from adjacency or mentions. `observed_root_id` stays null unless the UI establishes a root; currently the inspected layout does not do so. `ancestor_context_ids` identifies the earlier context that was actually displayed, without claiming a complete ancestor chain.

Only the main Conversation timeline before a recognized recommendation boundary is admitted. Ads, repost recommendations and protected posts are excluded. Scrolling collects incrementally and deduplicates IDs, including posts later removed by DOM virtualization. Normal long-text/reply controls are expanded within budgets; content is never ranked by agreement, importance or engagement by this server. Thread order is X's displayed order, usually labeled Relevant. Search explicitly verifies the selected Top/Latest tab; unsupported or changed layouts return an error instead of silently switching modes. The user's Posts tab may place pinned posts first.

Every retrieval reports timestamps, ordering, collected counts, expansion depth, unresolved parents, unexpanded branches and its stop reason. A no-further-visible-content result means only that the bounded page traversal found nothing further; `complete` is always false. A challenge, rate limit or account restriction stops browser work and requires manual resolution/restart. Partial evidence is retained when a later navigation, deadline or access barrier interrupts collection.

## Continuation and bounds

Thread cursors resume pending breadth-first work and buffered posts; search/profile cursors page a stored result snapshot. They do not rerun the first page. Keep **all original arguments** unchanged and pass `next_cursor`. Each cursor is consumed once, expires after ten minutes from the initial snapshot, and is invalidated by restart, eviction or clear-cache. Mismatched and expired cursors are explicit errors. Up to four traversals, 200 posts per traversal, 32 page visits total, 1,000 media references and about 240 KB of post data per response are retained. Media IDs expire too. Content is held in memory; no post dataset is written to disk.

Small per-call settings can be supplied in PowerShell before starting the server. `.env` files are ignored by git but are **not** loaded automatically.

| Variable                 | Default | Allowed                                  |
| ------------------------ | ------- | ---------------------------------------- |
| `X_READER_PORT`          | 8765    | 1024–65535; always loopback              |
| `X_READER_HEADLESS`      | Enabled | `0` opens visible reading windows        |
| `X_READER_NAVIGATION_MS` | 20000   | 3000–45000                               |
| `X_READER_DEADLINE_MS`   | 45000   | 5000–90000, active retrieval only        |
| `X_READER_QUEUE_MS`      | 90000   | 1000–180000; separate bounded queue wait |
| `X_READER_SCROLLS`       | 5       | 1–12 per page                            |
| `X_READER_PAGES`         | 8       | 1–16 per thread call                     |
| `X_READER_CACHE_SECONDS` | 600     | 30–1800                                  |

Navigation and extraction failures before the first collected post get at most one retry after 500 ms, within the same active deadline, with the exact URL/query/sort. Access barriers, sort mismatches and unexpected redirects are never retried. Partial retrievals preserve their evidence without restarting the snapshot. A later cursor can resume an unfinished branch within the total traversal budget. Login walls are not empty results. At most eight browser jobs are admitted; browser work is serialized. Each job receives its full active deadline after acquiring the queue slot. Excess work or an expired queue wait returns `busy`; cancellation while queued returns promptly. HTTP checks the loopback peer, exact Host, and any Origin, and rejects cross-site browser requests. The local OS user and authenticated tunnel operator are trusted. Do not proxy this endpoint publicly.

Profiles, `.env*`, session artifacts, debug captures, dependency caches and local tools are git-ignored. The application does not export cookies or storage state, and does not log raw browser errors or request headers. Login and authentication-verification screens are never captured. Recordings and traces are disabled. Attachment image capture occurs only when `read_media` is requested. There is no MCP navigation, JS, shell, filesystem, messaging or write capability.

## Live verification and prompts

Tests use synthetic pages in isolated browsers, clearly separate from live X. The live command uses the **official MCP client**, tests thread and nested-reply retrieval, verifies both search modes and user posts, and independently compares several returned posts against rendered browser fields. Optional quote/image URLs add those checks. Its compact report separates assertions, skipped checks and partial-retrieval warnings; a passed assertion does not erase a reported collection error. It never captures login screens.

Choose a public discussion with at least three participants and a nested reply within that discussion:

```powershell
$threadUrl = Read-Host 'Public thread URL'
$replyUrl = Read-Host 'Nested reply URL from that thread'
$searchQuery = Read-Host 'Search query'
npm run test:live -- --thread $threadUrl --query $searchQuery --nested $replyUrl
```

Optionally add `--quote <post-url>` for a post containing a quote and `--image <post-url>` for a post containing an image, replacing each placeholder with a real URL. Live content can change or disappear. See [VERIFICATION.md](VERIFICATION.md) for the actual checks run during implementation.

Example prompts:

- “Use x-reader to look at what users are claiming in this thread: <X link>. Identify distinct claims, supporting evidence, disagreements and corrections. Cite each individual post. Separate firsthand reports from speculation and repetition, and state what the retrieval missed.”
- “Continue the same thread with the returned cursor. Include author follow-ups and other participants; do not choose replies based on likes or agreement.”
- “Search X for <query> in latest mode, then compare it with top mode. Explain the sampling limits.”
- “Read @username's recent public posts and cite the posts relevant to <topic>.”
- “Use read_media for the attached chart before discussing what the image shows.”

DOM repair is isolated in `src/dom.ts`; browser access-state checks are in `src/browser.ts`. The transport and tool registration use the [official MCP SDK](https://ts.sdk.modelcontextprotocol.io/server). Browser lifecycle follows [Playwright persistent-context documentation](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context).

## Combining searches and request logs

Call `search_x` once per query and requested sort, then deduplicate by the string `posts[].id`. Preserve the reports, query/sort metadata and cursors from each call; there is no meaningful single Latest/Top ordering or cursor across different searches. The local `combineSearchResults(results)` export in `dist/combine.js` returns first-seen unique `posts`, `matches` linking IDs to source result indexes, and every original result in `searches`. It keeps all observed versions and limitations and performs no ranking or analysis.

```js
import { combineSearchResults } from "./dist/combine.js";
const combined = combineSearchResults([latestResult, topResult]);
```

Readable request logs go to stderr for both transports, such as `[INFO][12:05:30] search_x completed in 1240ms`, followed by the query, post URL or username, requested limits, returned count and stop reason. Readable logs omit request IDs. Starts, failures, queue waits and retries are logged too. `npm start` suppresses routine tunnel internals and formats tunnel warnings and errors as concise diagnostic lines. Set `X_READER_LOG_FORMAT=json` to get structured application logs for automated analysis. Error responses include the request ID. Application logs include search query text but omit post bodies, cookies, headers and raw browser exceptions. Logged post URLs omit query parameters and fragments. Redirect stderr locally if persistence is wanted.

Run `npm run test:search-live` with the dedicated session signed in. It asserts actual post retrieval for all four Astra regression queries in Latest and Top, both sequentially and as eight concurrent MCP requests, plus native operators, ID deduplication and two explicit zero-result checks. Any partial failure or missing evidence fails the run. The live suite does not prove exhaustive search coverage.
