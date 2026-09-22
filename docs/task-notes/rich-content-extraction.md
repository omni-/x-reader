# Rich-content verification — 2026-09-22

The original MCP response for [the repro](https://x.com/lon/status/2101034933284417614) contained `text: null` and four image references. The full Article was already in X's rendered DOM, but the extractor only recognized `tweetText` and Article preview cards. Tables, formulas and references also needed a short scroll/loading step.

The fixed response keeps `post.text: null` and returns `article.title: "The Inference Gap"`, author Lon Lundgren (`Lon`), 40,380 text characters, 185 ordered blocks, seven tables, six links and seven image references. `article.source` is `rendered_dom`; `article.truncated` is false. The official MCP client live test compared every prose block and table cell with an independently inspected page, checked the links, and confirmed the same Article text/blocks/links in `get_thread`. The last Article figure was retrieved successfully through `read_media`.

The current tunnel client's initialization advertises no MCP sampling capability. The user chose interpretation by ChatGPT from supplied image pixels, without a separate vision endpoint. `get_post` and `get_thread` therefore deliver labeled images and `media_content` mappings. They do not claim server-side OCR or descriptions. Article figures remain available on demand; Article body text never uses OCR.

## Live image checks

- [NWS text-heavy image](https://x.com/nws/status/2102129507071103371): a complete 1080 × 1350 PNG, 1,077,627 bytes, delivered through the official MCP client in both `get_post` and `get_thread`.
- [NASA ordinary image](https://x.com/nasa/status/2100953558015250850): a complete 1920 × 1078 PNG, 1,133,153 bytes, delivered through both tools.
- [Normal text post](https://x.com/jack/status/20): `just setting up my twttr`, with no Article or media.

The initial visual check opened PNGs exported by the SDK client locally. That verified readability, but did not test the ChatGPT wrapper. Subsequent Codex connector calls also exposed the NWS and NASA images to the model using the forwarding step below. The following content is derived from those image pixels, separate from the posts' original text:

**NWS transcription.** Title: “WINTERIZE YOUR HOME”. Left-side callouts, top to bottom: “Test smoke and carbon monoxide detectors”; “Insulate your attic”; “Clean out gutters”; “Gather supplies”. Right-side callouts, top to bottom: “Inspect your chimney”; “Caulk and weather strip doors/windows”; “Insulate exposed pipes”. Footer: “weather.gov/safety”, NOAA and National Weather Service logos. All seven callouts and the footer were legible.

**NASA description.** A brownish Moon sits above Earth's bright blue atmospheric horizon. White clouds cover the visible Earth below, with black space filling most of the frame.

## Reproduce

```powershell
npm test
npm run check
npm run test:rich-live -- --text-image https://x.com/nws/status/2102129507071103371 --image https://x.com/nasa/status/2100953558015250850 --text https://x.com/jack/status/20 --output .local/rich-content-live
```

The live script makes six checks through the official MCP SDK client. `--endpoint http://127.0.0.1:8765/mcp` selects a running HTTP server instead of a stdio subprocess. Optional PNG exports are for visual verification and are ignored by Git. Synthetic browser/MCP regressions cover the nested Article layout, bodies longer than 16K, lazy tables and links, complete text-heavy/ordinary image frames, normal text, image failures, and image budgets.

Implementation checks: `npm test` passed all 43 tests; `npm run check` passed TypeScript and Prettier checks; `git diff --check` passed. After restarting the local server with the final build, a fresh official HTTP MCP client again retrieved the 40,380-character Article with seven tables and the complete NWS image. The app's existing connector initially returned HTTP 504 on two status calls after restart. Subsequent connector calls succeeded, as detailed below.

## Connector delivery and model visibility

`status: "provided_to_client"` records that x-reader included pixels in the MCP response. It is not an acknowledgment from the client or model. `server_analysis: false` records that the server performed no OCR or description. Neither field establishes that an image was read.

Live calls through the x-reader connector in Codex returned both `structuredContent` and `content`. The former contained image metadata; the latter contained `type: "image"`, `mimeType: "image/png"` and base64 `data`. Explicitly forwarding those image blocks through Codex's `image(block)` helper made the pixels visible to the model:

- `get_post` supplied the complete NWS infographic and NASA photograph at the dimensions listed above.
- `get_post` retrieved the repro Article with 40,380 text characters and seven image references.
- `read_media` supplied the Article's second figure as a 2047 × 1324 PNG. Its image block was at `content[0]`, with 1,158,248 base64 characters. The model could inspect the chart, including its separate Turns and Invocations columns and median labels of 2,028 and 123 tokens.

For a fresh `media_id` returned by `get_post`, the working Codex forwarding pattern is:

```js
const result = await tools.mcp__codex_apps__x_reader_read_media({ media_id });
for (const block of result.content ?? []) {
  if (block.type === "image") image(block);
}
```

This example requires the host's image-output helper. Serializing `structuredContent` alone omits the pixels; serializing the full result with `text()` does not turn the base64 data into vision input.

The user separately confirmed that the Article and all seven image retrievals worked in their ChatGPT conversation. That conversation reported that its `functions.exec` wrapper exposes `text()` but no `image()` helper, leaving the model unable to inspect the returned images. This is a limitation of that observed ChatGPT path, not a claim about every ChatGPT client. Its internal wrapper implementation was not available for inspection here.

That wrapper needs to forward MCP image blocks automatically or provide an image-output primitive. x-reader's default MCP response remains unchanged; no server OCR or description fallback was added. An SDK payload test alone must not be reported as proof that the ChatGPT model received pixels.

## Limits

Image interpretation belongs to the calling model; the server does not persist generated transcriptions/descriptions. A client that cannot expose MCP image content to its model cannot perform that interpretation. Inline delivery is bounded to four images and 4 MiB per response; `read_media` handles deferred attachments. X may reduce uploaded image resolution. Cropped fallback, unavailable images, missing Article embeds and content budgets are explicit. Videos remain metadata-only.
