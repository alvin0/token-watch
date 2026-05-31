/**
 * High-performance bounded-memory line reader for JSONL files.
 *
 * Reads raw binary buffers and scans for newlines using Buffer.indexOf(),
 * only decoding UTF-8 for lines within the size cap. Oversized lines are
 * skipped without buffering or decoding their content.
 *
 * This module MUST NOT import `vscode`.
 * Requirements: 4.13, 4.14, 4.15
 */

import { openSync, readSync, closeSync, fstatSync } from "node:fs";

export interface LineReaderOptions {
  filePath: string;
  startOffset: number;
  maxLineBytes: number;
}

export interface LineReaderStats {
  endOffset: number;
  oversizedCount: number;
}

/** Read buffer size — 256 KB for good throughput on large files. */
const READ_BUF_SIZE = 256 * 1024;

/**
 * Read a file line-by-line from `startOffset` with bounded memory.
 *
 * - Uses raw binary Buffer reads + indexOf(\n) for fast newline scanning.
 * - Lines longer than `maxLineBytes` are skipped without decoding.
 * - `onLine` receives each valid line (decoded UTF-8) and its byte offset.
 * - Handles partial lines at EOF.
 */
export async function readLines(
  opts: LineReaderOptions,
  onLine: (line: string, byteOffset: number) => void,
): Promise<LineReaderStats> {
  const { filePath, startOffset, maxLineBytes } = opts;

  const fd = openSync(filePath, "r");
  try {
    const fileSize = fstatSync(fd).size;
    const readBuf = Buffer.allocUnsafe(READ_BUF_SIZE);

    let filePos = startOffset; // current read position in file
    let oversizedCount = 0;

    // Accumulator for partial lines spanning chunk boundaries
    let pending: Buffer | null = null;
    let lineStartOffset = startOffset;
    let oversized = false;

    while (filePos < fileSize) {
      const toRead = Math.min(READ_BUF_SIZE, fileSize - filePos);
      const bytesRead = readSync(fd, readBuf, 0, toRead, filePos);
      if (bytesRead === 0) break;

      let chunkStart = 0;

      while (chunkStart < bytesRead) {
        const nlIdx = readBuf.indexOf(0x0a, chunkStart); // find \n
        const foundNewline = nlIdx !== -1 && nlIdx < bytesRead;

        if (foundNewline) {
          // We have a complete line ending at nlIdx
          const segment = readBuf.subarray(chunkStart, nlIdx);

          if (oversized) {
            // Was already oversized from a previous chunk — just skip
            oversizedCount++;
            oversized = false;
            pending = null;
          } else if (pending !== null) {
            // Combine pending + this segment
            const fullLine = Buffer.concat([pending, segment]);
            pending = null;
            if (fullLine.length > maxLineBytes) {
              oversizedCount++;
            } else {
              emitLine(fullLine, lineStartOffset, onLine);
            }
          } else {
            // Entire line is within this chunk
            if (segment.length > maxLineBytes) {
              oversizedCount++;
            } else {
              emitLine(segment, lineStartOffset, onLine);
            }
          }

          chunkStart = nlIdx + 1;
          lineStartOffset = filePos + chunkStart;
        } else {
          // No newline found in remaining chunk — accumulate
          const segment = readBuf.subarray(chunkStart, bytesRead);

          if (oversized) {
            // Already oversized, just skip bytes
          } else if (pending !== null) {
            const newPending = Buffer.concat([pending, segment]);
            if (newPending.length > maxLineBytes) {
              oversized = true;
              pending = null;
            } else {
              pending = newPending;
            }
          } else {
            if (segment.length > maxLineBytes) {
              oversized = true;
            } else {
              // Copy segment since readBuf will be reused
              pending = Buffer.from(segment);
            }
          }

          chunkStart = bytesRead; // consumed entire chunk
        }
      }

      filePos += bytesRead;
    }

    // Handle partial line at EOF (no trailing newline)
    if (oversized) {
      oversizedCount++;
    } else if (pending !== null && pending.length > 0) {
      emitLine(pending, lineStartOffset, onLine);
    }

    return { endOffset: filePos, oversizedCount };
  } finally {
    closeSync(fd);
  }
}

/** Decode a line buffer and emit it, stripping trailing \r. */
function emitLine(
  buf: Buffer,
  byteOffset: number,
  onLine: (line: string, byteOffset: number) => void,
): void {
  // Strip trailing \r
  const len = buf.length > 0 && buf[buf.length - 1] === 0x0d ? buf.length - 1 : buf.length;
  if (len === 0) return;
  const line = buf.toString("utf8", 0, len);
  onLine(line, byteOffset);
}
