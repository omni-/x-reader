// A deterministic adapter-contract fixture, not a speech recognition model.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const wav = await readFile(process.argv[2]);
assert.equal(wav.toString("ascii", 0, 4), "RIFF");
assert.equal(wav.toString("ascii", 8, 12), "WAVE");
assert.ok(wav.length > 16000);
process.stdout.write(
  JSON.stringify([
    { start_seconds: 0.1, end_seconds: 0.5, text: "Adapter fixture output" },
  ]),
);
