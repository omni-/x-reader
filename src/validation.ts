import { z } from "zod";
import { ReaderError } from "./errors.js";

const hosts = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
]);
const reserved = new Set([
  "home",
  "search",
  "explore",
  "messages",
  "notifications",
  "settings",
  "intent",
  "i",
  "compose",
  "login",
  "logout",
  "account",
]);
export function username(value: string): string {
  const name = value.startsWith("@") ? value.slice(1) : value;
  if (!/^[A-Za-z0-9_]{1,15}$/.test(name) || reserved.has(name.toLowerCase()))
    throw new ReaderError(
      "invalid_username",
      "Use a public X handle containing 1–15 letters, digits or underscores.",
    );
  return name.toLowerCase();
}

export function postUrl(value: string): { id: string; url: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ReaderError(
      "invalid_url",
      "Expected an HTTPS X/Twitter post permalink.",
    );
  }
  if (
    !value.startsWith("https://") ||
    /[\s\\]/.test(value) ||
    /\/\.{1,2}(?:\/|$)/.test(value.split(/[?#]/)[0]!) ||
    url.protocol !== "https:" ||
    !hosts.has(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  )
    throw new ReaderError(
      "invalid_url",
      "Only HTTPS X/Twitter post permalinks without credentials or custom ports are accepted.",
    );
  const match =
    /^\/(?:([A-Za-z0-9_]{1,15})\/status|i\/status)\/([1-9][0-9]{0,24})(?:\/(?:photo|video)\/[1-4])?\/?$/.exec(
      url.pathname,
    );
  if (
    !match ||
    (match[1] && match[1] !== "i" && reserved.has(match[1].toLowerCase()))
  )
    throw new ReaderError(
      "invalid_url",
      "Expected /handle/status/post-id or /i/status/post-id.",
    );
  const id = match[2]!;
  return {
    id,
    url: `https://x.com/${match[1] ? match[1].toLowerCase() : "i"}/status/${id}`,
  };
}

export const postUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      postUrl(value);
      return true;
    } catch {
      return false;
    }
  }, "Expected a safe HTTPS X/Twitter post permalink");
export const usernameSchema = z
  .string()
  .max(16)
  .refine((value) => {
    try {
      username(value);
      return true;
    } catch {
      return false;
    }
  }, "Invalid X handle");
export const cursorSchema = z.string().uuid().optional();
export const getPostInput = z.object({ url: postUrlSchema }).strict();
export const threadInput = z
  .object({
    url: postUrlSchema,
    max_posts: z.number().int().min(1).max(100).default(40),
    max_depth: z.number().int().min(0).max(3).default(2),
    cursor: cursorSchema,
  })
  .strict();
export const searchInput = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine(
        (s) => !/[\u0000-\u001f\u007f]/.test(s),
        "Control characters are not allowed",
      ),
    limit: z.number().int().min(1).max(100).default(20),
    sort: z.enum(["latest", "top"]).default("latest"),
    cursor: cursorSchema,
  })
  .strict();
export const userInput = z
  .object({
    username: usernameSchema,
    limit: z.number().int().min(1).max(100).default(20),
    cursor: cursorSchema,
  })
  .strict();

export function safeEvidenceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    // Do not return common credential-bearing query values from rendered links.
    for (const key of [...url.searchParams.keys()]) {
      if (
        /^(?:token|access_token|auth|authorization|cookie|session|sessionid|api_key|password|code)$/i.test(
          key,
        )
      )
        url.searchParams.delete(key);
    }
    return url.href.slice(0, 2048);
  } catch {
    return null;
  }
}

export function allowedImage(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "pbs.twimg.com" &&
      !url.port &&
      !url.username &&
      !url.password &&
      /^\/media\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9]+)?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}
