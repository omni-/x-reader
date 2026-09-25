import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import type { Page, Route } from "playwright";
import { z } from "zod";
import { checkSignal } from "./browser.js";
import { collectPage } from "./dom.js";
import { ReaderError, logEvent, publicError } from "./errors.js";
import type { MediaImage } from "./media.js";
import { readVideoInput, allowedVideoResource } from "./validation.js";
import {
  VideoFiles,
  ffmpeg,
  probe,
  runLocal,
  parsePlaylist,
  localInputFormats,
} from "./video-files.js";

export type VideoRef = {
  type: "video";
  post_url: string;
  post_id: string;
  src: string;
  index: number;
};
type Options = z.output<typeof readVideoInput>;
type Cue = { start_seconds: number; end_seconds: number; text: string };

export function sampleTimes(
  duration: number,
  options: Pick<
    Options,
    "start_seconds" | "end_seconds" | "timestamps" | "frame_count"
  >,
) {
  if (!Number.isFinite(duration) || duration <= 0)
    throw new ReaderError(
      "video_unsupported",
      "A finite video duration is required; live streams are unsupported.",
    );
  const start = options.start_seconds ?? 0;
  const end =
    options.end_seconds ??
    (options.timestamps ? duration : Math.min(duration, start + 600));
  if (
    start >= duration ||
    end > duration ||
    end <= start ||
    (!options.timestamps && end - start > 600)
  )
    throw new ReaderError(
      "invalid_input",
      "Use a range within the video duration, at most 600 seconds, or up to 12 specific timestamps.",
    );
  if (
    options.timestamps &&
    (options.timestamps.length > options.frame_count ||
      options.timestamps.some((t) => t < start || t >= end))
  )
    throw new ReaderError(
      "invalid_input",
      "Timestamps must fall within the requested range (end exclusive), and their count must not exceed frame_count (maximum 12).",
    );
  const times =
    options.timestamps ??
    Array.from(
      { length: options.frame_count },
      (_, i) => start + ((i + 0.5) * (end - start)) / options.frame_count,
    );
  return { start, end, times };
}

export function parseVtt(text: string, videoStart = 0): Cue[] {
  if (!text.trimStart().startsWith("WEBVTT"))
    throw new ReaderError(
      "captions_unavailable",
      "Only WebVTT captions are supported.",
    );
  const seconds = (value: string) =>
    value.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  const map = /X-TIMESTAMP-MAP=([^\r\n]+)/.exec(text)?.[1];
  const local = map && /LOCAL:([\d:.]+)/.exec(map)?.[1];
  const clock = map && /MPEGTS:(\d+)/.exec(map)?.[1];
  if (map && (!local || !clock))
    throw new ReaderError(
      "captions_unavailable",
      "Unsupported WebVTT timestamp map.",
    );
  const offset =
    local && clock ? Number(clock) / 90000 - seconds(local) - videoStart : 0;
  const cues: Cue[] = [];
  for (const block of text.split(/\r?\n\s*\r?\n/)) {
    const match = /(?:^|\n)([\d:.]+) --> ([\d:.]+)[^\n]*\n([\s\S]*)/.exec(
      block,
    );
    if (!match) continue;
    const start = seconds(match[1]!) + offset,
      end = seconds(match[2]!) + offset;
    if (!Number.isFinite(start) || end <= start) continue;
    cues.push({
      start_seconds: Math.max(0, start),
      end_seconds: end,
      text: match[3]!
        .replace(/<[^>]*>/g, "")
        .trim()
        .slice(0, 2000),
    });
    if (cues.length > 500)
      throw new ReaderError(
        "captions_too_large",
        "Captions exceed 500 cues; no partial transcript is presented as complete.",
      );
  }
  return cues;
}

async function decodedFrame(
  path: string,
  start: number,
  requested: number,
  dimension: number,
  signal: AbortSignal,
  post_url: string,
  original: { width?: number; height?: number },
): Promise<MediaImage> {
  const ratio = Math.min(
    1,
    dimension / original.width!,
    dimension / original.height!,
    Math.sqrt(4_000_000 / (original.width! * original.height!)),
  );
  const width = Math.max(1, Math.floor(original.width! * ratio)),
    height = Math.max(1, Math.floor(original.height! * ratio));
  const hls = path.endsWith(".m3u8");
  const { stdout, stderr } = await runLocal(
    ffmpeg(),
    [
      "-hide_banner",
      "-nostdin",
      "-threads",
      "1",
      "-filter_threads",
      "1",
      "-max_alloc",
      "67108864",
      "-protocol_whitelist",
      "file,pipe",
      "-format_whitelist",
      localInputFormats(path),
      ...(hls ? [] : ["-ss", String(requested)]),
      "-copyts",
      "-i",
      basename(path),
      "-map",
      "0:v:0",
      "-an",
      "-sn",
      "-vf",
      `${hls ? `select='gte(t,${Math.max(0, start + requested - 1e-7)})',` : ""}scale=${width}:${height},showinfo`,
      "-frames:v",
      "1",
      "-fps_mode",
      "passthrough",
      "-c:v",
      "png",
      "-threads",
      "1",
      "-f",
      "image2pipe",
      "pipe:1",
    ],
    signal,
    4 * 1024 * 1024,
    dirname(path),
  );
  const match = /\bn:\s*0\s+pts:\s*(-?\d+)\s+pts_time:/.exec(stderr);
  const timeBase = /config in time_base: (\d+)\/(\d+)/.exec(stderr);
  if (
    !match ||
    !timeBase ||
    stdout.length < 24 ||
    stdout.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
  )
    throw new ReaderError(
      "frame_unavailable",
      "No decoded frame exists at that timestamp. Request an earlier timestamp; no poster was substituted.",
    );
  // pts_time is rounded in FFmpeg logs; use integer PTS and its time base.
  const timestamp =
    (Number(match[1]) * Number(timeBase[1])) / Number(timeBase[2]) - start;
  if (
    !Number.isFinite(timestamp) ||
    timestamp < -0.01 ||
    Math.abs(timestamp - requested) > 2
  )
    throw new ReaderError(
      "frame_timestamp_unavailable",
      "The decoded timestamp could not be matched to the requested timeline. No frame was mislabeled or substituted.",
    );
  return {
    data: stdout.toString("base64"),
    mimeType: "image/png",
    post_url,
    width: stdout.readUInt32BE(16),
    height: stdout.readUInt32BE(20),
    source: "decoded_video_frame",
    timestamp_seconds: Math.max(0, timestamp),
    limitations: [
      "Decoded presentation timestamp; a requested time can fall between frames.",
      `Frame fits ${dimension}px; the CDN variant may be smaller than the original upload.`,
    ],
  };
}

export async function contactSheet(
  page: Page,
  frames: MediaImage[],
): Promise<MediaImage> {
  const sheet = await page.evaluate(async (frames) => {
    const columns = Math.min(4, frames.length),
      width = columns * 320,
      height = Math.ceil(frames.length / columns) * 248;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#101010";
    ctx.fillRect(0, 0, width, height);
    for (const [i, frame] of frames.entries()) {
      const image = new Image();
      image.src = `data:image/png;base64,${frame.data}`;
      await image.decode();
      const x = (i % columns) * 320,
        y = Math.floor(i / columns) * 248;
      const scale = Math.min(312 / image.width, 216 / image.height);
      ctx.drawImage(
        image,
        x + (320 - image.width * scale) / 2,
        y + (220 - image.height * scale) / 2,
        image.width * scale,
        image.height * scale,
      );
      ctx.fillStyle = "white";
      ctx.font = "16px monospace";
      const t = frame.timestamp_seconds!;
      ctx.fillText(
        `${Math.floor(t / 60)
          .toString()
          .padStart(2, "0")}:${(t % 60).toFixed(3).padStart(6, "0")} s`,
        x + 8,
        y + 240,
      );
    }
    return {
      data: canvas.toDataURL("image/png").split(",")[1]!,
      width,
      height,
    };
  }, frames);
  return {
    ...sheet,
    mimeType: "image/png",
    post_url: frames[0]!.post_url,
    source: "contact_sheet",
    limitations: [
      "Sparse decoded frames with actual timestamps, not continuous video coverage. Motion or events between samples may be missed.",
      "Use each frame media_id with read_media for up to 2048px pixels.",
    ],
  };
}

export async function captureVideo(
  page: Page,
  reference: VideoRef,
  options: Options,
  signal: AbortSignal,
) {
  const permitted = new Set<string>(),
    observed = new Set<string>();
  type Player = { src: string; poster: string; tracks: string[] };
  const seenPlayers: Player[] = [];
  const playersOnPost = () =>
    page.evaluate((postId) => {
      const root = [
        ...document.querySelectorAll('article[data-testid="tweet"]'),
      ].find((e) => {
        const href = e.querySelector("a:has(time)")?.getAttribute("href");
        return href && new RegExp(`/status/${postId}(?:/|$)`).test(href);
      });
      return [...(root?.querySelectorAll("video") ?? [])]
        .filter(
          (v) => !v.closest('[data-testid="quoteTweet"], div[role="link"]'),
        )
        .map((v) => ({
          src: v.currentSrc || v.src,
          poster: v.poster,
          tracks: [...v.querySelectorAll("track")]
            .filter((t) => ["captions", "subtitles"].includes(t.kind))
            .map((t) => t.src),
        }));
    }, reference.post_id);
  // The normal reader blocks media. This page gate also stops background HLS fetches.
  const gate = async (route: Route) => {
    const request = route.request(),
      url = request.url();
    if (
      permitted.has(url) &&
      request.headers().accept === "application/octet-stream" &&
      request.method() === "GET"
    ) {
      await route.fallback();
      return;
    }
    if (
      new URL(url).hostname === "video.twimg.com" ||
      request.resourceType() === "media" ||
      /\.(?:m3u8|mp4|m4s|ts|webm)(?:\?|$)/.test(url)
    ) {
      if (allowedVideoResource(url) && observed.size < 128) {
        observed.add(url);
        // X can remove the video element when blocked playback fails.
        const players = await playersOnPost().catch(() => []);
        for (const player of players)
          if (
            !seenPlayers.some(
              (p) => p.poster === player.poster && p.src === player.src,
            ) &&
            seenPlayers.length < 16
          )
            seenPlayers.push(player);
      }
      await route.abort();
    } else await route.fallback();
  };
  await page.route("**/*", gate);
  let directory: string | undefined;
  try {
    let verified = false;
    await collectPage(
      page,
      reference.post_url,
      "post",
      signal,
      (post) => {
        if (post.id === reference.post_id) {
          const videos = [...post.media, ...(post.article?.media ?? [])].filter(
            (m) => m.type === "video",
          );
          verified = reference.src
            ? videos.some((m) => m.url === reference.src) ||
              (!!videos[reference.index] &&
                seenPlayers.some(
                  (v) => v.poster.split("?")[0] === reference.src,
                ))
            : !!videos[reference.index];
        }
      },
      { depth: 0, maxDepth: 0 },
    );
    if (!verified)
      throw new ReaderError(
        "media_unavailable",
        "The video is no longer present on that public post. Retrieve the post again.",
      );
    const players = await playersOnPost();
    const player =
      [...players, ...seenPlayers].find(
        (v) =>
          reference.src &&
          (v.src === reference.src || v.poster.split("?")[0] === reference.src),
      ) ??
      (reference.src
        ? undefined
        : (players[reference.index] ?? seenPlayers[reference.index]));
    if (!player)
      throw new ReaderError(
        "video_unavailable",
        "No playable video element is rendered for this attachment. Broadcast links and posters alone are unsupported.",
      );
    const key = /\/(?:ext_tw_video|amplify_video)(?:_thumb)?\/(\d+)\//.exec(
      player.poster || reference.src,
    )?.[1];
    const source = allowedVideoResource(player.src)
      ? player.src
      : [...observed].find(
          (url) =>
            key &&
            new URL(url).pathname.includes(`/${key}/`) &&
            /\.(m3u8|mp4)$/.test(new URL(url).pathname),
        );
    if (!source)
      throw new ReaderError(
        "video_unavailable",
        "No CDN playback resource could be tied to the discovered video. Retrieve the post again; a thumbnail cannot substitute for video frames.",
      );
    checkSignal(signal);
    await runLocal(ffmpeg(), ["-version"], signal, 16384);
    directory = await mkdtemp(join(tmpdir(), "x-reader-video-"));
    const files = new VideoFiles(page, directory, permitted, signal);
    const loaded = await files.load(source);
    const info = await probe(loaded.path, signal);
    if (!info.video)
      throw new ReaderError(
        "video_unavailable",
        "The retrieved resource contains no decoded video stream.",
      );
    const plan = sampleTimes(info.duration, options);
    const frames: MediaImage[] = [];
    for (const time of plan.times) {
      checkSignal(signal);
      frames.push(
        await decodedFrame(
          loaded.path,
          info.start,
          time,
          options.max_frame_dimension,
          signal,
          reference.post_url,
          info.video,
        ),
      );
    }
    if (
      frames.some(
        (f) =>
          f.timestamp_seconds! < plan.start - 1e-6 ||
          f.timestamp_seconds! >= plan.end,
      )
    )
      throw new ReaderError(
        "frame_unavailable",
        "The selected range contains no frame at one or more sample points. Widen the range or request an earlier timestamp.",
      );
    let audio = info.audio;
    if (!audio && loaded.audio) {
      try {
        audio = (await probe(loaded.audio, signal)).audio;
      } catch (error) {
        checkSignal(signal);
        if (
          !(error instanceof ReaderError) ||
          !["decode_failed", "decode_timeout"].includes(error.code)
        )
          throw error;
        loaded.audioLimitation =
          "The separate audio stream could not be decoded; audio and speech transcription are unavailable.";
        logEvent({
          level: "warn",
          event: "audio_unavailable",
          post_id: reference.post_id,
          code: error.code,
        });
      }
    }
    const captions: {
      source: "captions";
      status: "available" | "unavailable";
      cues: Cue[];
      limitations: string[];
    } = {
      source: "captions",
      status: "unavailable",
      cues: [],
      limitations: [],
    };
    const captionUrl = player.tracks[0] ?? loaded.captions;
    if (captionUrl || info.subtitles) {
      try {
        const bytes = captionUrl
          ? await files.fetch(captionUrl, 1024 * 1024)
          : (
              await runLocal(
                ffmpeg(),
                [
                  "-v",
                  "error",
                  "-nostdin",
                  "-protocol_whitelist",
                  "file,pipe",
                  "-format_whitelist",
                  localInputFormats(loaded.path),
                  "-i",
                  basename(loaded.path),
                  "-map",
                  "0:s:0",
                  "-f",
                  "webvtt",
                  "pipe:1",
                ],
                signal,
                1024 * 1024,
                directory,
              )
            ).stdout;
        if (captionUrl && new URL(captionUrl).pathname.endsWith(".m3u8")) {
          const playlist = parsePlaylist(bytes.toString("utf8"), captionUrl);
          for (const url of playlist.resources.values())
            captions.cues.push(
              ...parseVtt(
                (await files.fetch(url, 1024 * 1024)).toString("utf8"),
                info.start,
              ),
            );
        } else captions.cues = parseVtt(bytes.toString("utf8"), info.start);
        if (captions.cues.length > 500)
          throw new ReaderError(
            "captions_too_large",
            "Captions exceed 500 cues.",
          );
        captions.cues = captions.cues.filter(
          (c) => c.end_seconds > plan.start && c.start_seconds < plan.end,
        );
        captions.status = "available";
        captions.limitations.push(
          "Available source captions; they may themselves be automatic. Only cues overlapping the requested range are returned.",
        );
      } catch (error) {
        checkSignal(signal);
        captions.cues = [];
        captions.limitations.push(publicError(error).message);
        logEvent({
          level: "warn",
          event: "captions_unavailable",
          post_id: reference.post_id,
          code: publicError(error).code,
        });
      }
    } else
      captions.limitations.push(
        "No accessible caption track was discovered in the player or playlist.",
      );
    const transcript: {
      source: "local_speech_transcription";
      status: "available" | "not_requested" | "not_configured" | "unavailable";
      cues: Cue[];
      limitations: string[];
    } = {
      source: "local_speech_transcription",
      status: "not_requested",
      cues: [],
      limitations: [],
    };
    if (options.transcribe) {
      const command = process.env.X_READER_TRANSCRIBER;
      if (!audio) {
        transcript.status = "unavailable";
        transcript.limitations.push(
          "No audio stream is available; no speech transcription was generated.",
        );
      } else if (!command) {
        transcript.status = "not_configured";
        transcript.limitations.push(
          "Set X_READER_TRANSCRIBER to a local executable that accepts a WAV path and emits timestamped JSON cues. No model is downloaded automatically.",
        );
      } else {
        try {
          if (plan.end - plan.start > 600)
            throw new ReaderError(
              "transcription_range",
              "Local transcription is limited to 600 seconds. Supply a shorter time range.",
            );
          const wav = join(directory, "speech.wav");
          await runLocal(
            ffmpeg(),
            [
              "-v",
              "error",
              "-nostdin",
              "-threads",
              "1",
              "-protocol_whitelist",
              "file,pipe",
              "-format_whitelist",
              localInputFormats(loaded.audio ?? loaded.path),
              "-i",
              basename(loaded.audio ?? loaded.path),
              "-ss",
              String(plan.start),
              "-t",
              String(plan.end - plan.start),
              "-vn",
              "-ac",
              "1",
              "-ar",
              "16000",
              "-c:a",
              "pcm_s16le",
              "-fs",
              "20000000",
              wav,
            ],
            signal,
            4 * 1024 * 1024,
            directory,
          );
          const args = z
            .array(z.string().max(2048))
            .max(8)
            .parse(JSON.parse(process.env.X_READER_TRANSCRIBER_ARGS ?? "[]"));
          const output = await runLocal(
            command,
            [...args, wav],
            signal,
            128 * 1024,
          );
          const parsed = z
            .array(
              z.object({
                start_seconds: z.number().finite().nonnegative(),
                end_seconds: z.number().finite().nonnegative(),
                text: z.string().max(2000),
              }),
            )
            .max(500)
            .parse(JSON.parse(output.stdout.toString("utf8")));
          if (
            parsed.some(
              (c) =>
                c.end_seconds <= c.start_seconds ||
                c.end_seconds > plan.end - plan.start + 0.1,
            )
          )
            throw new ReaderError(
              "transcription_invalid",
              "Local transcript timestamps fall outside the supplied audio range.",
            );
          transcript.cues = parsed.map((c) => ({
            ...c,
            start_seconds: c.start_seconds + plan.start,
            end_seconds: c.end_seconds + plan.start,
          }));
          transcript.status = "available";
          transcript.limitations.push(
            "Generated locally from audio, not source captions; speech recognition can be wrong.",
          );
        } catch (error) {
          checkSignal(signal);
          transcript.status = "unavailable";
          transcript.limitations.push(publicError(error).message);
          logEvent({
            level: "warn",
            event: "transcription_unavailable",
            post_id: reference.post_id,
            code: publicError(error).code,
          });
        }
      }
    }
    const sheet = await contactSheet(page, frames);
    if (plan.end < info.duration || plan.start > 0)
      sheet.limitations.push(
        "Only the selected time range was sampled; the rest of the video was not inspected.",
      );
    return {
      sheet,
      frames,
      metadata: {
        duration_seconds: info.duration,
        coverage: {
          start_seconds: plan.start,
          end_seconds: plan.end,
          sampled_start_seconds: Math.min(
            ...frames.map((f) => f.timestamp_seconds!),
          ),
          sampled_end_seconds: Math.max(
            ...frames.map((f) => f.timestamp_seconds!),
          ),
          fraction: (plan.end - plan.start) / info.duration,
          complete: false as const,
        },
        captions,
        audio: {
          status: audio ? ("available" as const) : ("unavailable" as const),
          limitations: audio
            ? []
            : [loaded.audioLimitation ?? "No audio stream was found."],
        },
        transcript,
      },
      requested: plan.times,
    };
  } finally {
    await page.unroute("**/*", gate).catch(() => {});
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
