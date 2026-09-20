import {
  mkdir,
  open,
  readFile,
  unlink,
  lstat,
  realpath,
  rm,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ROOT, LOCAL, PROFILE, LOCK } from "./config.js";
import { ReaderError } from "./errors.js";

export async function safeProfilePath(): Promise<string> {
  const base = await realpath(ROOT);
  for (const path of [LOCAL, PROFILE]) {
    const stat = await lstat(path).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
      return null;
    });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new ReaderError(
        "unsafe_profile",
        "Dedicated profile path must be a real directory, not a link.",
      );
    if (
      stat &&
      (await realpath(path)).toLowerCase() !==
        resolve(
          base,
          ".local",
          ...(path === PROFILE ? ["x-browser-profile"] : []),
        ).toLowerCase()
    )
      throw new ReaderError(
        "unsafe_profile",
        "Profile resolved outside its expected installation directory.",
      );
  }
  return PROFILE;
}

export async function acquireProfile(): Promise<() => Promise<void>> {
  await safeProfilePath();
  await mkdir(LOCAL, { recursive: true });
  const nonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(LOCK, "wx", 0o600);
      await file.writeFile(JSON.stringify({ pid: process.pid, nonce }));
      await file.close();
      return async () => {
        const current = JSON.parse(
          await readFile(LOCK, "utf8").catch(() => "{}"),
        );
        if (current.nonce === nonce) await unlink(LOCK);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = JSON.parse(
        await readFile(LOCK, "utf8").catch(() => "{}"),
      ) as { pid?: number };
      let alive = true;
      if (Number.isSafeInteger(owner.pid) && owner.pid! > 0) {
        try {
          process.kill(owner.pid!, 0);
        } catch (e) {
          alive = (e as NodeJS.ErrnoException).code !== "ESRCH";
        }
      }
      if (alive || attempt > 0)
        throw new ReaderError(
          "profile_locked",
          "The dedicated browser is already in use. Close the login browser or other x-reader server normally, then retry.",
        );
      await unlink(LOCK);
    }
  }
  throw new ReaderError(
    "profile_locked",
    "Could not acquire the dedicated profile.",
  );
}

export async function resetProfile(confirmation: string): Promise<void> {
  if (confirmation !== "RESET x-reader")
    throw new ReaderError(
      "confirmation_required",
      "Type RESET x-reader to delete only the dedicated local profile.",
    );
  const release = await acquireProfile();
  try {
    await safeProfilePath();
    // Refuse Chromium's native locks too; never remove another browser's locks.
    for (const name of ["SingletonLock", "SingletonCookie", "lockfile"]) {
      if (await lstat(join(PROFILE, name)).catch(() => null))
        throw new ReaderError(
          "profile_locked",
          "A browser lock remains. Close the dedicated browser before resetting.",
        );
    }
    await rm(PROFILE, { recursive: true, force: true });
  } finally {
    await release();
  }
}
