import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { card, wrap } from "./fixtures.mjs";

// Optional local developer binaries; CI can supply PATH or the explicit variables.
for (const [key, path] of [
  [
    "X_READER_FFMPEG",
    ".local/media-tools/node_modules/ffmpeg-static/ffmpeg.exe",
  ],
  [
    "X_READER_FFPROBE",
    ".local/media-tools/node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe",
  ],
])
  if (!process.env[key] && existsSync(path)) process.env[key] = resolve(path);

export const videoUrl = "https://x.com/clip/status/950";
export const cdn = "https://video.twimg.com/ext_tw_video/950/pu/vid/colors.mp4";
export async function videoRoutes(page, options = {}) {
  const src =
    options.src ??
    (options.hls
      ? cdn.replace(
          "colors.mp4",
          options.brokenAudio ? "master.m3u8" : "colors.m3u8",
        )
      : cdn);
  const video = `<div data-testid="videoPlayer"><video preload="none" poster="https://pbs.twimg.com/ext_tw_video_thumb/950/pu/img/poster.jpg" src="${src}">${options.captions ? '<track kind="captions" src="https://video.twimg.com/subtitles/950/captions.vtt">' : ""}</video></div>`;
  await page.route(videoUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: wrap(
        card("950", "clip", "Fixture video").replace(
          "</article>",
          video + "</article>",
        ),
        options.protected ? { ui: "These posts are protected" } : {},
      ),
    }),
  );
  await page.route("https://video.twimg.com/**", async (route) => {
    const url = route.request().url();
    if (
      options.onFetch &&
      route.request().headers().accept === "application/octet-stream"
    )
      await options.onFetch(route.request());
    if (options.redirect)
      return route.fulfill({
        status: 302,
        headers: { Location: options.redirect },
      });
    if (url.endsWith(".vtt"))
      return route.fulfill({
        contentType: "text/vtt",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: "WEBVTT\n\n00:00.000 --> 00:01.500\nFirst cue\n\n00:02.000 --> 00:03.500\nSecond cue\n",
      });
    if (options.brokenAudio && url.endsWith("master.m3u8"))
      return route.fulfill({
        contentType: "application/vnd.apple.mpegurl",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",URI="broken.mp4"\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=160x90,AUDIO="audio"\ncolors.m3u8\n',
      });
    if (options.brokenAudio && url.endsWith("broken.mp4"))
      return route.fulfill({
        contentType: "video/mp4",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: Buffer.from(
          "000000186674797069736f6d0000000069736f6d000000",
          "hex",
        ),
      });
    if (options.hls)
      return route.fulfill({
        contentType: url.endsWith(".m3u8")
          ? "application/vnd.apple.mpegurl"
          : "video/mp4",
        body: readFileSync(
          new URL(
            `./assets/hls/${new URL(url).pathname.split("/").at(-1)}`,
            import.meta.url,
          ),
        ),
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    const body =
      options.body ??
      readFileSync(
        new URL(
          `./assets/${options.oversized ? "oversized" : options.audio ? "colors-audio" : "colors"}.mp4`,
          import.meta.url,
        ),
      );
    await route.fulfill({
      contentType: "video/mp4",
      body,
      headers: {
        "Access-Control-Allow-Origin": "*",
        ...(options.large ? { "Content-Length": "100000000" } : {}),
      },
    });
  });
}
