import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, copyFile, writeFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { LOCAL, ROOT } from "../dist/config.js";

test("bundled startup diagnoses prerequisites and closes HTTP when its child exits", async () => {
  const project = await mkdtemp(join(LOCAL, "tunnel-test-"));
  const run = async (env) => {
    try {
      await promisify(execFile)(
        process.execPath,
        [join(project, "dist/cli.js"), "tunnel"],
        {
          cwd: project,
          env: {
            ...process.env,
            CONTROL_PLANE_API_KEY: "",
            OPENAI_API_KEY: "",
            X_READER_LOG_FORMAT: "text",
            ...env,
          },
          timeout: 10000,
          windowsHide: true,
        },
      );
      assert.fail("Expected startup failure or child exit");
    } catch (error) {
      return error;
    }
  };
  try {
    await cp(join(ROOT, "dist"), join(project, "dist"), { recursive: true });
    await writeFile(join(project, "package.json"), '{"type":"module"}');
    assert.match((await run({})).stderr, /tunnel_missing/);
    const bundle = join(project, ".local/tunnel-client");
    await mkdir(bundle, { recursive: true });
    // A real, inert child process exercises supervision without contacting a tunnel service.
    await copyFile(
      process.execPath,
      join(
        bundle,
        process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client",
      ),
    );
    assert.match((await run({})).stderr, /tunnel_credentials_missing/);
    await writeFile(
      join(project, "run"),
      `console.log(JSON.stringify({ level: "INFO", msg: "noisy startup internals" }));
console.log(JSON.stringify({ level: "WARN", msg: "upstream unavailable", error: "connection refused", client_instance_id: "hidden-instance" }));
console.error("configure tunnel-client: missing profile");
console.error(process.argv.slice(2).join(" "));
setTimeout(() => { process.stderr.write("last diagnostic without newline"); process.exitCode = 7; }, 200);`,
    );
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const result = await run({
      CONTROL_PLANE_API_KEY: "synthetic-unused",
      X_READER_PORT: String(port),
    });
    assert.equal(result.code, 7);
    assert.match(result.stderr, /Tunnel exited/);
    assert.match(result.stderr, new RegExp(`url=http://127.0.0.1:${port}/mcp`));
    assert.match(
      result.stderr,
      /\[WARN\]\[\d{2}:\d{2}:\d{2}\] Tunnel: upstream unavailable \(error=connection refused\)/,
    );
    assert.match(
      result.stderr,
      /Tunnel: configure tunnel-client: missing profile/,
    );
    assert.match(result.stderr, /last diagnostic without newline/);
    assert.match(
      result.stderr,
      /--log.format json --log.level warn --log.file stdout/,
    );
    assert.doesNotMatch(
      result.stderr,
      /noisy startup internals|hidden-instance/,
    );
    assert.equal(result.stdout, "");
    await assert.rejects(fetch(`http://127.0.0.1:${port}/mcp`));
  } finally {
    assert.ok(!relative(LOCAL, project).startsWith("..") && project !== LOCAL);
    await rm(project, { recursive: true, force: true });
  }
});
