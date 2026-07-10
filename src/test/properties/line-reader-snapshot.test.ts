import * as assert from "node:assert";
import { appendFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readLines } from "../../worker/parsers/lineReader.js";

suite("Line reader snapshot and responsiveness", () => {
  test("does not read bytes appended after the captured snapshot boundary", async () => {
    const path = join(tmpdir(), `line-snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    const snapshot = "first\nsecond\n";
    writeFileSync(path, snapshot);
    appendFileSync(path, "third\n");
    const lines: string[] = [];
    try {
      const stats = await readLines(
        { filePath: path, startOffset: 0, endOffset: Buffer.byteLength(snapshot), maxLineBytes: 1024 },
        (line) => { lines.push(line); },
      );
      assert.deepStrictEqual(lines, ["first", "second"]);
      assert.strictEqual(stats.endOffset, Buffer.byteLength(snapshot));
    } finally {
      unlinkSync(path);
    }
  });

  test("yields to the event loop while scanning more than 16 MiB", async () => {
    const path = join(tmpdir(), `line-yield-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    const line = Buffer.alloc(1024, 0x61);
    line[line.length - 1] = 0x0a;
    const chunks = Array.from({ length: 17 * 1024 }, () => line);
    writeFileSync(path, Buffer.concat(chunks));
    let yielded = false;
    setImmediate(() => { yielded = true; });
    try {
      await readLines(
        { filePath: path, startOffset: 0, endOffset: 17 * 1024 * 1024, maxLineBytes: 2048 },
        () => undefined,
      );
      assert.strictEqual(yielded, true);
    } finally {
      unlinkSync(path);
    }
  });
});
