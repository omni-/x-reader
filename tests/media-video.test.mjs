import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { config } from "../dist/config.js";
import { chromium } from "playwright";
import { Reader } from "../dist/reader.js";
import {
  imageResult,
  boundResponse,
  MAX_RESPONSE_BYTES,
} from "../dist/media.js";
import { sampleTimes, parseVtt } from "../dist/video.js";
import { parsePlaylist, runLocal, VideoFiles } from "../dist/video-files.js";
import { readVideoInput, allowedVideoResource } from "../dist/validation.js";
import { FixtureBrowser, PNG } from "./fixtures.mjs";
import { videoRoutes, videoUrl, cdn } from "./video-fixtures.mjs";

test("image responses preserve MCP pixels and opt into identical structured pixels without text leakage", () => {
  const image = {
    data: PNG.toString("base64"),
    mimeType: "image/png",
    width: 1,
    height: 1,
    post_url: videoUrl,
    limitations: [],
    source: "cdn_image",
  };
  for (const source of ["cdn_image", "decoded_video_frame", "contact_sheet"]) {
    const normal = imageResult("id", { ...image, source });
    const compat = imageResult("id", { ...image, source }, true);
    assert.equal(normal.structuredContent.data.data_url, undefined);
    assert.deepEqual(normal.content, compat.content);
    assert.equal(
      compat.structuredContent.data.data_url,
      `data:image/png;base64,${image.data}`,
    );
    assert.ok(
      !compat.content.find((c) => c.type === "text").text.includes(image.data),
    );
  }
  assert.throws(
    () =>
      imageResult(
        "id",
        {
          ...image,
          data: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64"),
        },
        true,
      ),
    { code: "media_too_large" },
  );
  assert.throws(
    () =>
      boundResponse({
        content: [],
        structuredContent: { text: "x".repeat(MAX_RESPONSE_BYTES) },
      }),
    { code: "response_too_large" },
  );
});

test("video inputs, sampling ranges and every playlist resource fail closed", () => {
  const options = readVideoInput.parse({ media_id: crypto.randomUUID() });
  assert.deepEqual(
    sampleTimes(4, options).times,
    [0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75],
  );
  assert.throws(() => sampleTimes(4, { ...options, end_seconds: 5 }), {
    code: "invalid_input",
  });
  assert.throws(() => sampleTimes(4, { ...options, timestamps: [4] }), {
    code: "invalid_input",
  });
  assert.throws(() => readVideoInput.parse({ ...options, url: cdn }));
  assert.throws(() => readVideoInput.parse({ ...options, frame_count: 13 }));
  for (const url of [
    "https://127.0.0.1/a.mp4",
    "file:///secret",
    "https://video.twimg.com.evil.test/tweet_video/a.mp4",
    "https://user:pass@video.twimg.com/tweet_video/a.mp4",
    "http://video.twimg.com/tweet_video/a.mp4",
    "https://video.twimg.com:99/tweet_video/a.mp4",
    "https://video.twimg.com/tweet_video/%2e%2e/a.mp4",
  ])
    assert.equal(allowedVideoResource(url), false, url);
  const base = "https://video.twimg.com/ext_tw_video/950/pu/list.m3u8";
  const master =
    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=160x90\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=500,RESOLUTION=8000x8000\nhttps://evil.test/high.m3u8";
  assert.throws(
    () => parsePlaylist(master, base),
    { code: "media_refused" },
    "even an unselected variant must be checked",
  );
  for (const tag of [
    '#EXT-X-KEY:METHOD=AES-128,URI="file:///key"',
    '#EXT-X-MAP:URI="file:///secret"',
    '#EXT-X-MAP:URI="init.mp4",URI=file:///secret',
    "#EXT-X-MAP:URI=init.mp4",
    "#EXT-X-BYTERANGE:100@0",
  ])
    assert.throws(() =>
      parsePlaylist(
        `#EXTM3U\n${tag}\n#EXTINF:4,\npart.ts\n#EXT-X-ENDLIST`,
        base,
      ),
    );
  assert.throws(() => parsePlaylist("#EXTM3U\n#EXTINF:4,\npart.ts", base), {
    code: "video_unsupported",
  });
});

test("source WebVTT cues carry timestamps and are separate from speech transcription", () => {
  assert.deepEqual(
    parseVtt("WEBVTT\n\n00:01.000 --> 00:02.500\nHello <b>world</b>\n"),
    [{ start_seconds: 1, end_seconds: 2.5, text: "Hello world" }],
  );
  assert.deepEqual(
    parseVtt(
      "WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:900000\n\n00:01.000 --> 00:02.000\nMapped\n",
      10,
    )[0],
    { start_seconds: 1, end_seconds: 2, text: "Mapped" },
  );
});

async function pixels(data, points) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    return await page.evaluate(
      async ({ data, points }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const c = document.createElement("canvas");
        c.width = image.width;
        c.height = image.height;
        const ctx = c.getContext("2d");
        ctx.drawImage(image, 0, 0);
        return points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]);
      },
      { data, points },
    );
  } finally {
    await browser.close();
  }
}
const tempVideos = async () =>
  (await readdir(tmpdir()))
    .filter((name) => name.startsWith("x-reader-video-"))
    .sort();
async function withReader(options, work) {
  const reader = new Reader(
    new FixtureBrowser({ onPage: (page) => videoRoutes(page, options) }),
  );
  try {
    const post = (await reader.getPost({ url: videoUrl })).posts[0];
    assert.ok(post.media[0].media_id);
    return await work(reader, post.media[0].media_id);
  } finally {
    await reader.close();
  }
}

test("actual decoded frames, between-frame timestamps, contact-sheet pixels and higher-resolution IDs", async () => {
  const before = await tempVideos();
  await withReader({}, async (reader, media_id) => {
    const result = await reader.readVideo({ media_id });
    assert.equal(result.metadata.duration_seconds, 4);
    assert.deepEqual(
      result.metadata.frames.map((f) => f.timestamp_seconds),
      [0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75],
    );
    assert.equal(result.metadata.coverage.complete, false);
    assert.equal(result.metadata.audio.status, "unavailable");
    assert.equal(result.metadata.captions.status, "unavailable");
    assert.equal(result.metadata.transcript.status, "not_requested");
    const colors = await pixels(result.image.data, [
      [160, 110],
      [800, 110],
      [160, 358],
      [800, 358],
    ]);
    assert.ok(colors[0][0] > 240 && colors[0][1] < 10);
    assert.ok(colors[1][1] > 240 && colors[1][0] < 10);
    assert.ok(colors[2][2] > 240 && colors[2][0] < 10);
    assert.ok(colors[3][0] > 240 && colors[3][1] > 240);
    const sampled = await reader.readVideo({
      media_id,
      timestamps: [0.6],
      frame_count: 1,
      transcribe: true,
    });
    assert.equal(sampled.metadata.frames[0].timestamp_seconds, 0.75);
    assert.equal(sampled.metadata.transcript.status, "unavailable");
    const frame = await reader.readMedia(result.metadata.frames[4].media_id);
    assert.equal(frame.source, "decoded_video_frame");
    assert.equal(frame.timestamp_seconds, 2.25);
    assert.ok((await pixels(frame.data, [[80, 45]]))[0][2] > 240);
    await assert.rejects(reader.readMedia(media_id), { code: "media_refused" });
    await reader.close();
    await assert.rejects(reader.readVideo({ media_id }), {
      code: "cursor_expired",
    });
  });
  assert.deepEqual(await tempVideos(), before);
});

test("caption and audio availability, requested range, optional unconfigured transcription", async () => {
  await withReader(
    { audio: true, captions: true },
    async (reader, media_id) => {
      const result = await reader.readVideo({
        media_id,
        start_seconds: 1.5,
        end_seconds: 3.5,
        frame_count: 2,
        transcribe: true,
      });
      assert.equal(result.metadata.audio.status, "available");
      assert.equal(result.metadata.captions.source, "captions");
      assert.deepEqual(result.metadata.captions.cues, [
        { start_seconds: 2, end_seconds: 3.5, text: "Second cue" },
      ]);
      assert.equal(result.metadata.transcript.status, "not_configured");
      assert.equal(result.metadata.coverage.fraction, 0.5);
    },
  );
});

test("oversized source pixels, advertised bytes and redirects return actionable errors and clean scratch files", async () => {
  const before = await tempVideos();
  for (const [options, code] of [
    [{ oversized: true }, "media_too_large"],
    [{ large: true }, "media_too_large"],
    [{ redirect: "https://127.0.0.1/secret" }, "media_unavailable"],
  ])
    await withReader(options, async (reader, media_id) => {
      await assert.rejects(reader.readVideo({ media_id }), { code });
    });
  assert.deepEqual(await tempVideos(), before);
});

test("cancellation stops the downloader and local decoder, and removes temporary files", async () => {
  const before = await tempVideos();
  const controller = new AbortController();
  let fetches = 0;
  await withReader(
    {
      onFetch: async () => {
        fetches++;
        controller.abort();
      },
    },
    async (reader, media_id) => {
      await assert.rejects(reader.readVideo({ media_id }, controller.signal));
    },
  );
  assert.equal(fetches, 1);
  assert.deepEqual(await tempVideos(), before);
  const abort = new AbortController();
  const operation = runLocal(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    abort.signal,
  );
  abort.abort();
  await assert.rejects(operation, { code: "cancelled" });
});

test("streamed media size is bounded even without Content-Length", async () => {
  const browser = new FixtureBrowser({
    onPage: (page) => videoRoutes(page, { body: Buffer.alloc(5000) }),
  });
  await browser.run(async (page, signal) => {
    await page.goto(videoUrl);
    const files = new VideoFiles(page, tmpdir(), new Set(), signal);
    await assert.rejects(files.fetch(cdn, 100), { code: "media_too_large" });
  });
});

test("finite HLS is localized and decoded at presentation timestamps without keyframe seeking", async () => {
  await withReader({ hls: true }, async (reader, media_id) => {
    const result = await reader.readVideo({
      media_id,
      timestamps: [0.6, 2.1],
      frame_count: 2,
    });
    assert.deepEqual(
      result.metadata.frames.map((f) => f.timestamp_seconds),
      [0.75, 2.25],
    );
    const colors = await pixels(result.image.data, [
      [160, 110],
      [480, 110],
    ]);
    assert.ok(colors[0][0] > 240 && colors[0][2] < 10);
    assert.ok(colors[1][2] > 240 && colors[1][0] < 10);
  });
});

test("configured local transcription adapter receives decoded audio and returns separate, offset cues", async (t) => {
  const previous = [
    process.env.X_READER_TRANSCRIBER,
    process.env.X_READER_TRANSCRIBER_ARGS,
  ];
  t.after(() => {
    for (const [i, name] of [
      "X_READER_TRANSCRIBER",
      "X_READER_TRANSCRIBER_ARGS",
    ].entries()) {
      if (previous[i] === undefined) delete process.env[name];
      else process.env[name] = previous[i];
    }
  });
  process.env.X_READER_TRANSCRIBER = process.execPath;
  process.env.X_READER_TRANSCRIBER_ARGS = JSON.stringify([
    fileURLToPath(new URL("./transcriber-fixture.mjs", import.meta.url)),
  ]);
  await withReader(
    { audio: true, captions: true },
    async (reader, media_id) => {
      const result = await reader.readVideo({
        media_id,
        start_seconds: 1,
        end_seconds: 2,
        frame_count: 1,
        transcribe: true,
      });
      assert.equal(
        result.metadata.transcript.source,
        "local_speech_transcription",
      );
      assert.equal(result.metadata.transcript.status, "available");
      assert.deepEqual(result.metadata.transcript.cues, [
        {
          start_seconds: 1.1,
          end_seconds: 1.5,
          text: "Adapter fixture output",
        },
      ]);
      assert.equal(result.metadata.captions.cues[0].text, "First cue");
    },
  );
});

test("elapsed media TTL expires video and frame IDs without extending their lifetime", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  await withReader({}, async (reader, media_id) => {
    const result = await reader.readVideo({ media_id, frame_count: 1 });
    now += config.cacheMs + 1;
    await assert.rejects(reader.readVideo({ media_id }), {
      code: "cursor_expired",
    });
    await assert.rejects(reader.readMedia(result.metadata.frames[0].media_id), {
      code: "cursor_expired",
    });
  });
});

test("video rereads preserve public-access restrictions", async () => {
  const options = {};
  await withReader(options, async (reader, media_id) => {
    options.protected = true;
    await assert.rejects(reader.readVideo({ media_id }), {
      code: "protected_content",
    });
  });
});

test("a playlist disguised as a video never reaches a local-file-capable decoder", async () => {
  for (const text of [
    "#EXTM3U\n#EXTINF:4,\nfile:///not-allowed.mp4\n#EXT-X-ENDLIST",
    "ffconcat version 1.0\nfile '/not-allowed.mp4'",
  ]) {
    await withReader({ body: Buffer.from(text) }, async (reader, media_id) => {
      await assert.rejects(reader.readVideo({ media_id }), {
        code: "video_unsupported",
      });
    });
  }
});

test("video downloads omit browser cookies and Authorization headers", async () => {
  let checked = 0;
  const browser = new FixtureBrowser({
    onPage: async (page) => {
      await page.context().addCookies([
        {
          name: "test_session",
          value: "fixture-only",
          domain: "video.twimg.com",
          path: "/",
          secure: true,
          sameSite: "None",
        },
      ]);
      await videoRoutes(page, {
        onFetch: (request) => {
          assert.equal(request.headers().cookie, undefined);
          assert.equal(request.headers().authorization, undefined);
          checked++;
        },
      });
    },
  });
  const reader = new Reader(browser);
  try {
    const post = (await reader.getPost({ url: videoUrl })).posts[0];
    await reader.readVideo({
      media_id: post.media[0].media_id,
      frame_count: 1,
    });
    assert.equal(checked, 1);
  } finally {
    await reader.close();
  }
});

test("local processing timeout kills and reaps the child", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = runLocal(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    new AbortController().signal,
  );
  const rejected = assert.rejects(pending, { code: "decode_timeout" });
  t.mock.timers.tick(20001);
  await rejected;
});

test("unreadable separate audio is explicit while decoded frames remain available", async () => {
  await withReader(
    { hls: true, brokenAudio: true },
    async (reader, media_id) => {
      const result = await reader.readVideo({
        media_id,
        frame_count: 1,
        transcribe: true,
      });
      assert.equal(result.metadata.frames.length, 1);
      assert.equal(result.metadata.audio.status, "unavailable");
      assert.match(
        result.metadata.audio.limitations[0],
        /could not be decoded/,
      );
      assert.equal(result.metadata.transcript.status, "unavailable");
    },
  );
});
