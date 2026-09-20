import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Both src/ and dist/ are immediate children of the installation directory.
export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const LOCAL = resolve(ROOT, ".local");
export const PROFILE = resolve(LOCAL, "x-browser-profile");
export const LOCK = resolve(LOCAL, "browser.lock");

function integer(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || +value < min || +value > max)
    throw new Error(`Invalid ${name}; expected ${min}..${max}`);
  return +value;
}

export const config = {
  browserChannel: process.platform === "win32" ? "msedge" : "chromium",
  port: integer("X_READER_PORT", 8765, 1024, 65535),
  headless: process.env.X_READER_HEADLESS !== "0",
  navigationMs: integer("X_READER_NAVIGATION_MS", 20000, 3000, 45000),
  deadlineMs: integer("X_READER_DEADLINE_MS", 45000, 5000, 90000),
  scrolls: integer("X_READER_SCROLLS", 5, 1, 12),
  pages: integer("X_READER_PAGES", 8, 1, 16),
  cacheMs: integer("X_READER_CACHE_SECONDS", 600, 30, 1800) * 1000,
};
