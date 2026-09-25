import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, extname, dirname, basename } from "node:path";
import type { Page } from "playwright";
import { checkSignal } from "./browser.js";
import { ReaderError } from "./errors.js";
import { allowedVideoResource } from "./validation.js";

export const VIDEO_BYTES = 64 * 1024 * 1024;
const fail = (message: string): never => {
  throw new ReaderError("video_unsupported", message);
};
export function mediaUrl(value: string, base?: string): string {
  let url: string;
  try {
    url = new URL(value, base).href;
  } catch {
    throw new ReaderError(
      "media_refused",
      "Invalid video or playlist resource URL.",
    );
  }
  if (!allowedVideoResource(url))
    throw new ReaderError(
      "media_refused",
      "Video, caption or playlist resource is outside the allowed HTTPS X media CDN. No resource was followed.",
    );
  return url;
}

export type Playlist = {
  lines: string[];
  variants: {
    url: string;
    pixels: number;
    audio?: string;
    subtitles?: string;
  }[];
  tracks: { type: string; group: string; url: string }[];
  resources: Map<string, string>;
};
const attribute = (line: string, key: string) =>
  new RegExp(`(?:[:,])${key}=(?:"([^"]*)"|([^,]*))`)
    .exec(line)
    ?.slice(1)
    .find((v) => v !== undefined);

export function parsePlaylist(text: string, base: string): Playlist {
  if (
    Buffer.byteLength(text) > 1024 * 1024 ||
    !text.trimStart().startsWith("#EXTM3U")
  )
    return fail(
      "Invalid or oversized HLS playlist. Use a finite, unencrypted video.",
    );
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());
  const result: Playlist = {
    lines,
    variants: [],
    tracks: [],
    resources: new Map(),
  };
  if (
    lines.some((line) =>
      /^#EXT-X-(?:KEY|SESSION-KEY|BYTERANGE|PART|PRELOAD-HINT|DEFINE|DISCONTINUITY)/.test(
        line,
      ),
    )
  )
    return fail(
      "Encrypted, byte-range, discontinuous and low-latency HLS are unsupported. No playlist was passed to the decoder.",
    );
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    const uriFields = [...line.matchAll(/(?:^|[,:])URI=/g)].length;
    if (
      uriFields > 1 ||
      (uriFields && !/(?:^|[,:])URI="[^"\r\n]+"(?:,|$)/.test(line))
    )
      return fail("HLS resource URIs must be quoted and explicit.");
    if (line.startsWith("#EXT-X-MAP:") && /BYTERANGE/.test(line))
      return fail("Byte-range HLS initialization resources are unsupported.");
    for (const match of line.matchAll(/(?:^|[,:])URI="([^"]+)"/g)) {
      if (!/^#EXT-X-(?:MAP|MEDIA):/.test(line))
        return fail("Unsupported HLS resource tag.");
      result.resources.set(match[1]!, mediaUrl(match[1]!, base));
    }
    if (!line.startsWith("#") && line)
      result.resources.set(line, mediaUrl(line, base));
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const uri = lines[index + 1]?.trim();
      if (!uri || uri.startsWith("#")) return fail("Invalid HLS variant.");
      const [w, h] = (attribute(line, "RESOLUTION") ?? "0x0")
        .split("x")
        .map(Number);
      result.variants.push({
        url: mediaUrl(uri, base),
        pixels: w! * h!,
        audio: attribute(line, "AUDIO"),
        subtitles: attribute(line, "SUBTITLES"),
      });
    }
    if (line.startsWith("#EXT-X-MEDIA:")) {
      const uri = attribute(line, "URI");
      if (uri)
        result.tracks.push({
          type: attribute(line, "TYPE") ?? "",
          group: attribute(line, "GROUP-ID") ?? "",
          url: mediaUrl(uri, base),
        });
    }
  }
  if (!result.variants.length && !lines.includes("#EXT-X-ENDLIST"))
    return fail(
      "Live or unfinished HLS is unsupported. Retry after the video has ended.",
    );
  if (result.resources.size > 192)
    return fail("Playlist exceeds 192 resources. Use a shorter video.");
  return result;
}

/** Stream in the browser without cookies; reject redirects before following them. */
export class VideoFiles {
  private used = 0;
  private count = 0;
  constructor(
    private page: Page,
    private directory: string,
    private permitted: Set<string>,
    private signal: AbortSignal,
  ) {}
  async fetch(url: string, limit = VIDEO_BYTES): Promise<Buffer> {
    url = mediaUrl(url);
    checkSignal(this.signal);
    if (++this.count > 192)
      return fail("Video exceeds 192 downloads. Use a shorter video.");
    const remaining = Math.min(limit, VIDEO_BYTES - this.used);
    if (remaining <= 0)
      throw new ReaderError(
        "media_too_large",
        "Video exceeds the 64 MiB total download budget. Use a smaller video.",
      );
    this.permitted.add(url);
    try {
      const result = await this.page.evaluate(
        async ({ url, remaining }) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 12000);
          let length = 0;
          try {
            const response = await fetch(url, {
              credentials: "omit",
              redirect: "error",
              headers: { Accept: "application/octet-stream" },
              signal: controller.signal,
            });
            if (!response.ok || !response.body) return { error: "unavailable" };
            if (Number(response.headers.get("content-length")) > remaining) {
              await response.body.cancel();
              return { error: "size" };
            }
            const reader = response.body.getReader();
            const chunks: Uint8Array[] = [];
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              length += value.length;
              if (length > remaining) {
                await reader.cancel();
                return { error: "size", bytesRead: length };
              }
              chunks.push(value);
            }
            const parts: string[] = [];
            for (const chunk of chunks)
              for (let i = 0; i < chunk.length; i += 16384)
                parts.push(
                  String.fromCharCode(...chunk.subarray(i, i + 16384)),
                );
            return { data: btoa(parts.join("")), bytesRead: length };
          } catch {
            return { error: "unavailable", bytesRead: length };
          } finally {
            clearTimeout(timer);
          }
        },
        { url, remaining },
      );
      checkSignal(this.signal);
      this.used += result.bytesRead ?? 0;
      if (!result.data)
        throw new ReaderError(
          result.error === "size" ? "media_too_large" : "media_unavailable",
          result.error === "size"
            ? "Video resource exceeds the 64 MiB total or 1 MiB playlist/caption budget. Use a smaller video."
            : "The discovered CDN resource could not be fetched (redirects are refused). Retrieve the post again; access barriers are not bypassed.",
        );
      const bytes = Buffer.from(result.data, "base64");
      return bytes;
    } finally {
      this.permitted.delete(url);
    }
  }
  async load(
    url: string,
    depth = 0,
  ): Promise<{
    path: string;
    audio?: string;
    captions?: string;
    audioLimitation?: string;
  }> {
    if (depth > 3) return fail("HLS nesting exceeds three playlists.");
    const playlist = new URL(url).pathname.endsWith(".m3u8");
    const bytes = await this.fetch(url, playlist ? 1024 * 1024 : VIDEO_BYTES);
    if (!playlist) {
      assertBinaryMedia(bytes, extname(new URL(url).pathname));
      return { path: await this.save(bytes, extname(new URL(url).pathname)) };
    }
    const parsed = parsePlaylist(bytes.toString("utf8"), url);
    if (parsed.variants.length) {
      const variant = parsed.variants
        .filter((v) => v.pixels > 0 && v.pixels <= 4_000_000)
        .sort((a, b) => b.pixels - a.pixels)[0];
      if (!variant)
        return fail("No HLS variant fits the 4 million pixel budget.");
      const loaded = await this.load(variant.url, depth + 1);
      const audio = parsed.tracks.find(
        (t) => t.type === "AUDIO" && t.group === variant.audio,
      );
      const captions = parsed.tracks.find(
        (t) => t.type === "SUBTITLES" && t.group === variant.subtitles,
      );
      if (audio) {
        try {
          loaded.audio = (await this.load(audio.url, depth + 1)).path;
        } catch (error) {
          checkSignal(this.signal);
          if (
            !(error instanceof ReaderError) ||
            !["media_unavailable", "video_unsupported"].includes(error.code)
          )
            throw error;
          loaded.audioLimitation =
            "The separate audio resource could not be retrieved; frames are available but audio is unavailable.";
        }
      }
      if (captions) loaded.captions = captions.url;
      return loaded;
    }
    const names = new Map<string, string>();
    for (const [raw, resource] of parsed.resources) {
      if (new URL(resource).pathname.endsWith(".m3u8"))
        return fail("Unexpected nested media playlist.");
      const extension = extname(new URL(resource).pathname);
      const bytes = await this.fetch(resource);
      assertBinaryMedia(bytes, extension);
      const path = await this.save(bytes, extension);
      names.set(raw, path.replaceAll("\\", "/").split("/").at(-1)!);
    }
    const local = parsed.lines
      .map((line) => {
        if (!line.startsWith("#")) return names.get(line.trim()) ?? line;
        return line.replace(
          /URI="([^"]+)"/g,
          (_, uri: string) => `URI="${names.get(uri)}"`,
        );
      })
      .join("\n");
    return { path: await this.save(Buffer.from(local), ".m3u8") };
  }
  private async save(bytes: Buffer, extension: string): Promise<string> {
    const path = join(this.directory, `${crypto.randomUUID()}${extension}`);
    await writeFile(path, bytes, { mode: 0o600 });
    return path;
  }
}

// Do not let a mislabeled playlist reach a decoder that can open local files.
function assertBinaryMedia(bytes: Buffer, extension: string): void {
  const iso = [
    "ftyp",
    "styp",
    "moof",
    "moov",
    "sidx",
    "free",
    "skip",
    "wide",
  ].includes(bytes.toString("ascii", 4, 8));
  const valid = [".mp4", ".m4s"].includes(extension)
    ? iso
    : extension === ".webm"
      ? bytes.subarray(0, 4).toString("hex") === "1a45dfa3"
      : extension === ".ts"
        ? bytes[0] === 0x47 || bytes[4] === 0x47
        : extension === ".aac"
          ? bytes[0] === 0xff && (bytes[1]! & 0xf0) === 0xf0
          : false;
  if (!valid)
    fail(
      "Media bytes do not match the supported MP4/WebM/TS/AAC container. A nested or mislabeled playlist was not passed to the decoder.",
    );
}

export const localInputFormats = (path: string): string =>
  path.endsWith(".m3u8")
    ? "hls,mov,mpegts,aac"
    : "mov,matroska,webm,mpegts,aac";

/** No shell or network protocols. Kill and reap children before temporary-file cleanup. */
export async function runLocal(
  executable: string,
  args: string[],
  signal: AbortSignal,
  maxOutput = 4 * 1024 * 1024,
  cwd?: string,
): Promise<{ stdout: Buffer; stderr: string }> {
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let out = 0,
      err = 0;
    let failure: ReaderError | undefined;
    const abort = () => {
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      failure = new ReaderError(
        "decode_timeout",
        "Local media processing exceeded 20 seconds. Request fewer frames or a smaller video.",
      );
      abort();
    }, 20000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.length;
      if (out > maxOutput) {
        failure = new ReaderError(
          "media_too_large",
          "Decoder output exceeded its byte budget. Request a smaller frame.",
        );
        abort();
      } else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.length;
      if (err > 1024 * 1024) {
        failure = new ReaderError(
          "decode_failed",
          "Decoder diagnostics exceeded their budget.",
        );
        abort();
      } else stderr.push(chunk);
    });
    child.on("error", () => {
      failure = new ReaderError(
        "media_dependency_missing",
        "Install local FFmpeg and ffprobe (PNG/H.264/HLS support), or set X_READER_FFMPEG and X_READER_FFPROBE. A configured transcriber must also be executable. No binaries or models are downloaded automatically.",
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      try {
        checkSignal(signal);
      } catch (error) {
        reject(error);
        return;
      }
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new ReaderError(
            "decode_failed",
            "Local media decoding failed. Confirm FFmpeg codec support and retry a smaller, unencrypted video. Decoder output is redacted.",
          ),
        );
      else
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
    });
  });
}

export const ffmpeg = () => process.env.X_READER_FFMPEG || "ffmpeg";
export async function probe(path: string, signal: AbortSignal) {
  const { stdout } = await runLocal(
    process.env.X_READER_FFPROBE || "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-format_whitelist",
      localInputFormats(path),
      "-max_alloc",
      "67108864",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      basename(path),
    ],
    signal,
    256 * 1024,
    dirname(path),
  );
  const data = JSON.parse(stdout.toString("utf8")) as {
    streams: {
      codec_type: string;
      width?: number;
      height?: number;
      duration?: string;
      start_time?: string;
    }[];
    format: { duration?: string; start_time?: string };
  };
  const video = data.streams.find((s) => s.codec_type === "video");
  if (
    video &&
    (!(video.width! > 0 && video.height! > 0) ||
      video.width! * video.height! > 16_000_000)
  )
    throw new ReaderError(
      "media_too_large",
      "Source video exceeds 16 million decoded pixels. Use a lower-resolution video.",
    );
  return {
    duration: Number(data.format.duration ?? video?.duration),
    start: Number(data.format.start_time ?? video?.start_time ?? 0),
    video,
    audio: data.streams.some((s) => s.codec_type === "audio"),
    subtitles: data.streams.some((s) => s.codec_type === "subtitle"),
  };
}
