import { chromium } from "playwright";
import { config, PROFILE } from "./config.js";
import { acquireProfile } from "./profile.js";
import { ReaderError } from "./errors.js";
import { access } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

export async function edgeExecutable(): Promise<string> {
  for (const path of [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ])
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    )
      return path;
  throw new ReaderError(
    "browser_missing",
    "Install Microsoft Edge on Windows before opening the dedicated profile.",
  );
}

export async function checkEdgeProfilePolicy(): Promise<void> {
  if (process.platform !== "win32") return;
  for (const hive of ["HKLM", "HKCU"]) {
    const exists = await promisify(execFile)(
      "reg.exe",
      [
        "query",
        `${hive}\\SOFTWARE\\Policies\\Microsoft\\Edge`,
        "/v",
        "UserDataDir",
      ],
      { windowsHide: true },
    ).then(
      () => true,
      (error: { code?: unknown }) => {
        if (error.code === 1) return false;
        throw new ReaderError(
          "unsafe_profile",
          "Could not check Edge's profile-directory policy. Refusing to open an unverified profile location.",
        );
      },
    );
    if (exists)
      throw new ReaderError(
        "unsafe_profile",
        "An Edge UserDataDir policy can override the dedicated profile. Remove that policy or use another machine; x-reader will not open your normal profile.",
      );
  }
}

export async function login(): Promise<void> {
  const release = await acquireProfile();
  try {
    if (process.platform === "win32") {
      await checkEdgeProfilePolicy();
      const child = spawn(
        await edgeExecutable(),
        [
          `--user-data-dir=${PROFILE}`,
          "--no-first-run",
          "--no-default-browser-check",
          "https://x.com/home",
        ],
        { stdio: "ignore", shell: false },
      );
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", () =>
          reject(
            new ReaderError(
              "browser_launch_failed",
              "Could not launch the dedicated Edge window.",
            ),
          ),
        );
      });
      console.error(
        "Dedicated X browser launched in normal Edge. Sign in manually, then close this browser normally. No automation, screenshots, tracing, or credential inspection are attached during login.",
      );
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      return;
    }
    const context = await chromium
      .launchPersistentContext(PROFILE, {
        headless: false,
        viewport: { width: 1280, height: 900 },
        acceptDownloads: false,
        timeout: config.navigationMs,
      })
      .catch(() => {
        throw new ReaderError(
          "browser_launch_failed",
          "Could not open Chromium. Run npm run browser:install, and close any other dedicated X browser.",
        );
      });
    const closed = new Promise<void>((resolve) =>
      context.once("close", () => resolve()),
    );
    const stop = () => {
      void context.close();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page
        .goto("https://x.com/home", {
          waitUntil: "domcontentloaded",
          timeout: config.navigationMs,
        })
        .catch(() => {
          console.error(
            "X navigation did not finish. You can enter https://x.com/home in the dedicated browser.",
          );
        });
      console.error(
        "Dedicated X browser launched. Sign in manually, then close this browser normally. No screenshots, tracing, or credential inspection are enabled.",
      );
      // No DOM inspection or polling during the human authentication handoff.
      await closed;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await context.close();
    }
  } finally {
    await release();
  }
}
