/**
 * High-performance bounded-memory line reader for JSONL files.
 *
 * Reads raw binary buffers and scans for newlines using Buffer.indexOf(), only
 * decoding UTF-8 for lines it is going to parse.
 *
 * ON OVERSIZED LINES: `maxLineBytes` exists to bound memory, but a line being
 * long says nothing about whether it carries token counts. Agent logs routinely
 * exceed a megabyte on a single line — a tool result, or an assistant turn that
 * writes a large file — and an assistant turn carries `message.usage`. Dropping
 * those unread lost real tokens, silently.
 *
 * So a line over `maxLineBytes` is not discarded on length alone. It is scanned
 * for the caller's `usageMarkers`, and parsed anyway if it carries one, up to a
 * hard `recoveryLimitBytes` ceiling that keeps memory bounded. The three
 * outcomes are counted separately, so the UI can say whether anything was
 * actually lost instead of leaving the reader to guess.
 *
 * This module MUST NOT import `vscode`.
 * Requirements: 4.13, 4.14, 4.15
 */

import { openSync, readSync, closeSync, fstatSync } from "node:fs";

export interface LineReaderOptions {
  filePath: string;
  startOffset: number;
  endOffset?: number;
  maxLineBytes: number;
  /**
   * Byte sequences that mark a line as carrying token usage, e.g. `"usage"`.
   * A line over `maxLineBytes` containing one of these is still parsed.
   */
  usageMarkers?: readonly string[];
  /**
   * Hard ceiling on buffering one line. Beyond this a line cannot be parsed at
   * all; it is only classified. Defaults to eight times `maxLineBytes`, with a
   * floor of 8 MB.
   */
  recoveryLimitBytes?: number;
}

export interface LineReaderStats {
  endOffset: number;
  /**
   * Lines past `maxLineBytes` that carried no token data. Nothing countable was
   * in them, so nothing was lost.
   */
  oversizedSkippedCount: number;
  /**
   * Lines past `maxLineBytes` that carried token data and were parsed anyway.
   * Informational: these numbers ARE in the totals.
   */
  oversizedRecoveredCount: number;
  /**
   * Lines too large even to buffer that carried token data. This is the only
   * counter that means tokens are missing from the totals.
   */
  oversizedLostUsageCount: number;
}

/** Read buffer size — 256 KB for good throughput on large files. */
const READ_BUF_SIZE = 256 * 1024;
const YIELD_AFTER_BYTES = 16 * 1024 * 1024;
/** Floor for the recovery ceiling, so a small `maxLineBytes` still recovers. */
const MIN_RECOVERY_LIMIT_BYTES = 8 * 1024 * 1024;
const RECOVERY_LIMIT_FACTOR = 8;

/**
 * Read a file line-by-line from `startOffset` with bounded memory.
 *
 * - Uses raw binary Buffer reads + indexOf(\n) for fast newline scanning.
 * - `onLine` receives each line to parse (decoded UTF-8) and its byte offset.
 * - Handles partial lines at EOF.
 */
export async function readLines(
  opts: LineReaderOptions,
  onLine: (line: string, byteOffset: number, isCompleteLine: boolean) => void | boolean,
): Promise<LineReaderStats> {
  const { filePath, startOffset, endOffset, maxLineBytes } = opts;
  const markers = (opts.usageMarkers ?? []).map((marker) => Buffer.from(marker, "utf8"));
  // An explicit ceiling is honoured as given; the default is generous enough
  // that a real assistant turn writing a large file still fits.
  const recoveryLimit = Math.max(
    opts.recoveryLimitBytes ?? Math.max(maxLineBytes * RECOVERY_LIMIT_FACTOR, MIN_RECOVERY_LIMIT_BYTES),
    maxLineBytes,
  );
  /** Longest marker minus one: the most a marker can straddle a chunk edge. */
  const straddle = markers.reduce((longest, marker) => Math.max(longest, marker.length), 1) - 1;

  const fd = openSync(filePath, "r");
  try {
    const observedSize = fstatSync(fd).size;
    const fileSize = Math.min(observedSize, endOffset ?? observedSize);
    const readBuf = Buffer.allocUnsafe(READ_BUF_SIZE);

    let filePos = startOffset; // current read position in file
    const stats: LineReaderStats = {
      endOffset: startOffset,
      oversizedSkippedCount: 0,
      oversizedRecoveredCount: 0,
      oversizedLostUsageCount: 0,
    };

    // Accumulator for partial lines spanning chunk boundaries
    let pending: Buffer | null = null;
    let lineStartOffset = startOffset;
    /** Set once a line passes the recovery ceiling: bytes are no longer kept. */
    let abandoned = false;
    /** Whether a usage marker has been seen in the current abandoned line. */
    let abandonedHadUsage = false;
    /** Tail of the previous segment, so a marker split across chunks is found. */
    let abandonedTail: Buffer = Buffer.alloc(0);
    let bytesSinceYield = 0;

    const hasUsageMarker = (buf: Buffer): boolean =>
      markers.some((marker) => buf.includes(marker));

    /** Account for a line that was buffered whole. */
    const finishBuffered = (line: Buffer): void => {
      if (line.length <= maxLineBytes) {
        emitLine(line, lineStartOffset, true, onLine);
        return;
      }
      if (line.length > recoveryLimit) {
        // Enforced here too, not just while accumulating: a line short enough
        // to arrive inside one read buffer would otherwise bypass the ceiling
        // entirely and behave differently from an identical line that
        // straddled a chunk boundary.
        if (hasUsageMarker(line)) {
          stats.oversizedLostUsageCount++;
        } else {
          stats.oversizedSkippedCount++;
        }
        return;
      }
      if (hasUsageMarker(line)) {
        // Long, but it carries token counts — parse it rather than lose them.
        stats.oversizedRecoveredCount++;
        emitLine(line, lineStartOffset, true, onLine);
        return;
      }
      stats.oversizedSkippedCount++;
    };

    /** Account for a line that passed the ceiling and was never buffered. */
    const finishAbandoned = (): void => {
      if (abandonedHadUsage) {
        stats.oversizedLostUsageCount++;
      } else {
        stats.oversizedSkippedCount++;
      }
      abandoned = false;
      abandonedHadUsage = false;
      abandonedTail = Buffer.alloc(0);
    };

    /** Keep classifying an abandoned line without holding on to its bytes. */
    const scanAbandoned = (segment: Buffer): void => {
      if (abandonedHadUsage || markers.length === 0) { return; }
      const window = abandonedTail.length > 0 ? Buffer.concat([abandonedTail, segment]) : segment;
      if (hasUsageMarker(window)) {
        abandonedHadUsage = true;
        abandonedTail = Buffer.alloc(0);
        return;
      }
      abandonedTail = straddle > 0 && window.length > straddle
        ? Buffer.from(window.subarray(window.length - straddle))
        : Buffer.from(window);
    };

    while (filePos < fileSize) {
      const toRead = Math.min(READ_BUF_SIZE, fileSize - filePos);
      const bytesRead = readSync(fd, readBuf, 0, toRead, filePos);
      if (bytesRead === 0) {
        break;
      }

      let chunkStart = 0;

      while (chunkStart < bytesRead) {
        const nlIdx = readBuf.indexOf(0x0a, chunkStart); // find \n
        const foundNewline = nlIdx !== -1 && nlIdx < bytesRead;

        if (foundNewline) {
          const segment = readBuf.subarray(chunkStart, nlIdx);

          if (abandoned) {
            scanAbandoned(segment);
            finishAbandoned();
            pending = null;
          } else if (pending !== null) {
            finishBuffered(Buffer.concat([pending, segment]));
            pending = null;
          } else {
            finishBuffered(segment);
          }

          chunkStart = nlIdx + 1;
          lineStartOffset = filePos + chunkStart;
        } else {
          // No newline in the rest of the chunk — keep accumulating.
          const segment = readBuf.subarray(chunkStart, bytesRead);

          if (abandoned) {
            scanAbandoned(segment);
          } else {
            const grown: Buffer = pending !== null ? Buffer.concat([pending, segment]) : Buffer.from(segment);
            if (grown.length > recoveryLimit) {
              // Past the point where the line can be held in memory at all.
              abandoned = true;
              abandonedHadUsage = hasUsageMarker(grown);
              abandonedTail = straddle > 0 && grown.length > straddle
                ? Buffer.from(grown.subarray(grown.length - straddle))
                : Buffer.alloc(0);
              pending = null;
            } else {
              pending = grown;
            }
          }

          chunkStart = bytesRead; // consumed entire chunk
        }
      }

      filePos += bytesRead;
      bytesSinceYield += bytesRead;
      if (bytesSinceYield >= YIELD_AFTER_BYTES && filePos < fileSize) {
        bytesSinceYield = 0;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    // Handle partial line at EOF (no trailing newline)
    if (abandoned) {
      finishAbandoned();
    } else if (pending !== null && pending.length > 0) {
      if (pending.length > maxLineBytes && !hasUsageMarker(pending)) {
        stats.oversizedSkippedCount++;
      } else {
        if (pending.length > maxLineBytes) { stats.oversizedRecoveredCount++; }
        const accepted = emitLine(pending, lineStartOffset, false, onLine);
        if (accepted === false) {
          return { ...stats, endOffset: lineStartOffset };
        }
      }
    }

    return { ...stats, endOffset: filePos };
  } finally {
    closeSync(fd);
  }
}

/** Decode a line buffer and emit it, stripping trailing \r. */
function emitLine(
  buf: Buffer,
  byteOffset: number,
  isCompleteLine: boolean,
  onLine: (line: string, byteOffset: number, isCompleteLine: boolean) => void | boolean,
): void | boolean {
  // Strip trailing \r
  const len = buf.length > 0 && buf[buf.length - 1] === 0x0d ? buf.length - 1 : buf.length;
  if (len === 0) {
    return;
  }
  const line = buf.toString("utf8", 0, len);
  return onLine(line, byteOffset, isCompleteLine);
}
