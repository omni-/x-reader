# Image fallback and video verification — September 25, 2026

The default MCP image block is preserved. `structured_fallback: true` adds identical PNG pixels at `structuredContent.data.data_url`; it is disabled by default. Stills, decoded frames and contact sheets share the response builder. There is no server OCR or visual description. Article extraction stays separate.

## Repeat the checks

Install local FFmpeg/ffprobe as described in the README, then run:

```powershell
npm test
npm run check
node scripts/media-live.mjs --transport stdio
node scripts/media-live.mjs --transport http
```

The HTTP command starts an isolated loopback server on an available port. To test an existing freshly rebuilt server, add `--endpoint http://127.0.0.1:8765/mcp`. Both modes use the official MCP SDK client. Source URLs can be overridden with `--article`, `--image` and `--video`. Received PNGs and metadata without base64 are saved under `.local/media-live/<transport>/`; the script explicitly does not claim model vision.

The live cases are the [requested Article](https://x.com/lon/status/2101034933284417614), [NASA ordinary image](https://x.com/nasa/status/2100953558015250850), [public video reply](https://x.com/nuclearstorm235/status/2101309942108188882), and [ordinary text post](https://x.com/jack/status/20). The Article remains 40,380 text characters and seven tables, with matching `get_post`/`get_thread` body and blocks. Its second figure is 2047 × 1324; the NASA image is 1920 × 1078. The video is 105.846 seconds with 576 × 1280 decoded frames, an audio stream and no discovered caption track. Local speech recognition is unconfigured in the live environment.

Final live HTTP and stdio runs passed, each receiving seven PNG results: normal/compatibility Article figures and ordinary images, a compatibility contact sheet, an individual compatibility frame and a normal timestamp-selected sheet. The frame ID and explicit timestamp both returned exactly `46.322344888888885` seconds. The selected range remains sparse even when its endpoints cover the full duration.

The full regression run passed 55/55 tests. Final affected media/transport checks passed 20/20 after three additional security tests, and the separate broken-audio regression passed 1/1: 59 distinct tests were exercised across these runs. TypeScript, formatting of all edited files and `git diff --check` passed. The repository-wide `npm run check` still reports existing formatting failures in eight files unchanged from HEAD: `src/errors.ts`, `src/tunnel.ts`, `tests/fixtures.mjs`, `tests/logging.test.mjs`, `tests/rich-content.test.mjs`, `tests/tunnel.test.mjs`, `scripts/rich-content-live.mjs` and `package.json`. Those files and the pre-existing untracked `stdout` were left untouched.

FFmpeg/ffprobe were installed only in the ignored `.local/media-tools` directory for verification. In this checkout, use these paths before the live commands or server startup:

```powershell
$env:X_READER_FFMPEG = (Resolve-Path '.local/media-tools/node_modules/ffmpeg-static/ffmpeg.exe').Path
$env:X_READER_FFPROBE = (Resolve-Path '.local/media-tools/node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe').Path
```

The existing server on port 8765 was not replaced. Verification servers used separate loopback ports and were closed. No `x-reader-video-*` scratch directories remained after the completed runs.

## Server, transport and vision are separate checks

- **Server output:** deterministic tests check identical normal/compatibility PNG bytes, pixel colors decoded from an actual four-color MP4 and finite HLS, actual presentation timestamps, labeled contact sheets, expiring video/frame IDs, captions and missing audio, local transcription adapter output/offsets, access barriers, unsafe playlist resources, redirects, download/pixel/response limits, cancellation and scratch-file cleanup. Existing post/Article tests remain in the suite. The synthetic adapter verifies the audio/JSON contract, not speech recognition accuracy.
- **Transport:** official SDK clients over HTTP and stdio exercise `get_post`, `read_media` and `read_video`, including fallback extraction, frame IDs, schemas, source-text preservation and errors. The live script also verifies exact timestamp round trips: retrieving a frame ID or requesting its actual timestamp must not slip to the next frame.
- **Model vision:** the Codex Node runtime's actual `nodeRepl.emitImage` function was inspected and then successfully invoked with the received data URL string. The MCP SDK HTTP result's `structuredContent.data.data_url` was passed directly to that function. The returned image block was forwarded through the documented Codex image-output interface. No base64 was printed and no exported local image was used for this test. This establishes the tested Codex path, not every client.
- **Reported ChatGPT path:** inaccessible here and **unverified**. Adding a data URL does not fix a wrapper that lacks any image-input interface. No ChatGPT model-visibility claim is made.

Pixel observations from the received fallback images, separate from source text:

- Article figure: two purple stacked columns, orange horizontal guides at 50% and 96.3%, and detached upper tails. The dark slate zero-thinking segment occupies 39.2% of the Invocations column, labeled `(14,250)`, versus 6.0% `(413)` for Turns. These colors and layout are absent from media metadata.
- Ordinary image: the brown Moon is high and right of center, with dark space between it and Earth's blue atmospheric edge; white cloud bands fill the lower part of the image.
- Video contact sheet: early frames show a small object with solar panels against black space; later frames show a grayscale display with a diamond outline, then Earth and spacecraft hardware. One middle frame includes a phone-player overlay and a red progress bar. The individual frame near 86 seconds shows a white circular cover at lower right beside a dark metal truss, with clouds and Earth's diagonal blue edge behind it. The vertical black margins are part of the decoded video.

## Exact ChatGPT retest calls

Restart x-reader with the new build, refresh the connector's schemas, and execute these calls in one server lifetime. IDs are opaque and expire; never reuse IDs from these notes.

```js
const post = await client.callTool({
  name: "get_post",
  arguments: { url: "https://x.com/lon/status/2101034933284417614" },
});
const id = post.structuredContent.data.posts[0].article.media[1].media_id;
const standard = await client.callTool({
  name: "read_media",
  arguments: { media_id: id },
});
const compat = await client.callTool({
  name: "read_media",
  arguments: { media_id: id, structured_fallback: true },
});
const dataUrl = compat.structuredContent.data.data_url;
// Do not print dataUrl or the full result. Submit it as image input below.
```

Here `client.callTool` is the official MCP SDK interface. If the ChatGPT wrapper exposes only the structured object, use its documented equivalent field (`data.data_url` when the envelope is unwrapped). First inspect that wrapper's actual available image-input API and accepted argument shape. Do not assume `image()` exists. If it offers no image input, stop and record vision as unverified even if `dataUrl` exists.

For the tested **Codex Node runtime only**, the successful final submission was `await nodeRepl.emitImage(dataUrl)`. That runtime needed Node's `TransformStream` from `node:stream/web` installed on `globalThis` before importing the SDK HTTP transport. This is test-host setup, not an x-reader requirement. An API client with a vision-capable model can instead construct `{ type: "input_image", image_url: dataUrl }` inside a user input message, following [OpenAI's image-input documentation](https://developers.openai.com/api/docs/guides/images-vision); this separate API path was not executed and is not required.

After submission, ask the receiving model to identify column colors, the guide-line colors/positions, and one small bucket label. Record its actual answer and whether pixels entered the model, not merely whether an image widget rendered. Repeat with the ordinary-image URL above and its `posts[0].media[0].media_id`.

```js
const videoPost = await client.callTool({
  name: "get_post",
  arguments: {
    url: "https://x.com/nuclearstorm235/status/2101309942108188882",
  },
});
const videoId = videoPost.structuredContent.data.posts[0].media.find(
  (m) => m.type === "video",
).media_id;
const sheet = await client.callTool({
  name: "read_video",
  arguments: { media_id: videoId, structured_fallback: true },
});
const frame = await client.callTool({
  name: "read_media",
  arguments: {
    media_id: sheet.structuredContent.data.frames[6].media_id,
    structured_fallback: true,
  },
});
// Submit sheet.structuredContent.data.data_url and frame.structuredContent.data.data_url
// using the verified client image-input API, without echoing either value as text.
await client.callTool({
  name: "read_video",
  arguments: { media_id: videoId, timestamps: [1, 10], frame_count: 2 },
});
await client.callTool({
  name: "read_video",
  arguments: {
    media_id: videoId,
    start_seconds: 10,
    end_seconds: 20,
    frame_count: 4,
    transcribe: true,
  },
});
```

## Remaining limits

The server supports finite, unencrypted CDN media. It refuses redirects and live/encrypted/discontinuous/byte-range playlists and external broadcast origins. Playback resources must be tied to the verified public post; access changes fail closed. Downloading the selected variant and optional audio is bounded to 64 MiB, regardless of the requested range. Decoder subprocesses and browser work have deadlines. Temporary video/audio files are removed on completion, errors and cancellation; abrupt OS termination cannot promise cleanup. Image compatibility duplicates pixels and can increase client payload costs. Sparse frames cannot prove absence of events between timestamps. Caption languages are selected from the first available player track or the selected HLS variant; translation is not performed. Real speech-transcription quality and the reported ChatGPT wrapper remain unverified.
