import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { LOCAL } from "./config.js";
import { logEvent, ReaderError } from "./errors.js";
import { serveHttp } from "./http.js";
import type { Reader } from "./reader.js";

/** Run the configured secure tunnel and loopback server as one local process group. */
export async function serveTunnel(reader: Reader) {
  const executable = join(
    LOCAL,
    "tunnel-client",
    process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client",
  );
  await access(executable).catch(() => {
    throw new ReaderError(
      "tunnel_missing",
      "Install the official tunnel-client bundle in .local/tunnel-client, then run npm start again. See README.md.",
    );
  });
  if (!process.env.CONTROL_PLANE_API_KEY && !process.env.OPENAI_API_KEY)
    throw new ReaderError(
      "tunnel_credentials_missing",
      "Provide CONTROL_PLANE_API_KEY in the local environment and initialize the x-reader tunnel profile as described in README.md, then run npm start.",
    );
  const http = await serveHttp(reader);
  let child;
  try {
    child = spawn(
      executable,
      [
        "run",
        "--profile",
        process.env.TUNNEL_CLIENT_PROFILE ?? "x-reader",
        "--mcp.server-url",
        `url=${http.url}`,
        "--health.listen-addr",
        "127.0.0.1:0",
        "--log.format",
        "json",
        "--log.level",
        "warn",
        "--log.file",
        "stdout",
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false },
    );
    for (const stream of [child.stdout!, child.stderr!]) {
      const lines = createInterface({ input: stream });
      lines.on("line", (line) => {
        if (!line.trim()) return;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          logEvent({ level: "warn", message: `Tunnel: ${line}` });
          return;
        }
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          logEvent({ level: "warn", message: `Tunnel: ${line}` });
          return;
        }
        const level = String(entry.level ?? "warn").toLowerCase();
        if (!["warn", "error", "fatal"].includes(level)) return;
        logEvent({
          level: level === "fatal" ? "error" : level,
          message: `Tunnel: ${entry.msg ?? entry.message ?? "Diagnostic"}`,
          error: entry.error ?? entry.attrs?.error,
          status: entry.status_code ?? entry.attrs?.status_code,
        });
      });
    }
    await new Promise<void>((resolve, reject) => {
      child!.once("spawn", resolve);
      child!.once("error", () =>
        reject(
          new ReaderError(
            "tunnel_start_failed",
            "Cannot launch tunnel-client. Check the installed bundle and local process permissions.",
          ),
        ),
      );
    });
  } catch (error) {
    await http.close();
    throw error;
  }
  const exited = new Promise<number | null>((resolve) =>
    child.once("close", resolve),
  );
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      await http.close();
    })());
  void exited.then(async (code) => {
    if (!closing) {
      logEvent({
        level: "warn",
        event: "tunnel_stopped",
        code,
        message:
          "Tunnel exited; stopping the local server. Check tunnel-client diagnostics and restart npm start.",
      });
      process.exitCode = code || 1;
      await close();
    }
  });
  logEvent({
    level: "info",
    message: `x-reader listening on ${http.url}; tunnel starting. Ctrl+C stops both.`,
  });
  return { close };
}
