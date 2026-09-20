import { login } from "./login.js";
import { logFailure, ReaderError } from "./errors.js";
import { Reader, clearCache } from "./reader.js";
import { createMcpServer } from "./mcp.js";
import { serveHttp } from "./http.js";
import { serveTunnel } from "./tunnel.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resetProfile } from "./profile.js";
import { createInterface } from "node:readline/promises";

const reader = new Reader();
let closeTransport: (() => Promise<void>) | undefined;
let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await closeTransport?.();
  await reader.close();
  process.stdin.pause();
}

try {
  if (process.argv.length !== 3)
    throw new ReaderError(
      "unknown_command",
      "Use login, diagnostics, http, stdio, tunnel, clear-cache or reset-profile without extra arguments.",
    );
  const command = process.argv[2];
  if (command === "login") await login();
  else if (command === "diagnostics") {
    const result = await reader.status();
    console.log(JSON.stringify(result, null, 2));
    await reader.close();
    if (!result.ready) process.exitCode = 2;
  } else if (command === "reset-profile") {
    if (!process.stdin.isTTY)
      throw new ReaderError(
        "confirmation_required",
        "Run npm run reset-profile in an interactive local terminal.",
      );
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = await prompt.question(
        "Delete only x-reader's dedicated browser profile? Type RESET x-reader: ",
      );
      await resetProfile(answer);
      console.log(
        "Dedicated local profile deleted. This does not guarantee that the remote X or Google session was revoked; use their account security settings to revoke sessions.",
      );
    } finally {
      prompt.close();
    }
  } else if (command === "clear-cache") {
    await clearCache();
    console.log(
      "Stored snapshots and media references will be invalidated before the next tool call in each local server. Profiles are unaffected.",
    );
  } else if (
    command === "http" ||
    command === "stdio" ||
    command === "tunnel"
  ) {
    process.once("SIGINT", () => {
      void shutdown();
    });
    process.once("SIGTERM", () => {
      void shutdown();
    });
    if (command === "tunnel") {
      closeTransport = (await serveTunnel(reader)).close;
    } else if (command === "http") {
      const http = await serveHttp(reader);
      closeTransport = http.close;
      console.error(`x-reader listening on ${http.url}; loopback access only.`);
    } else {
      const server = createMcpServer(reader);
      closeTransport = () => server.close();
      server.server.onclose = () => {
        void shutdown();
      };
      await server.connect(new StdioServerTransport());
    }
  } else
    throw new ReaderError(
      "unknown_command",
      "Use login, diagnostics, http, stdio, tunnel, clear-cache or reset-profile.",
    );
} catch (error) {
  logFailure(error);
  await shutdown();
  process.exitCode = 1;
}
