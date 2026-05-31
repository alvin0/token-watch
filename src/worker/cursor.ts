import { createHash } from "node:crypto";
import { openSync, readSync, closeSync } from "node:fs";

export const HEAD_BYTES = 4096; // first N bytes for rotation/rewrite guard
export const TAIL_BYTES = 4096; // W bytes ending at lastByteOffset for append guard

/**
 * Compute a hash of the first N bytes of a file (rotation/rewrite guard).
 * Returns a hex SHA-256 hash of the first min(HEAD_BYTES, fileSize) bytes.
 */
export function computeHeadHash(filePath: string, fileSize: number): string {
  const bytesToRead = Math.min(HEAD_BYTES, fileSize);
  const buf = Buffer.alloc(bytesToRead);
  const fd = openSync(filePath, "r");
  try {
    readSync(fd, buf, 0, bytesToRead, 0);
  } finally {
    closeSync(fd);
  }
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Compute a hash of the W bytes ending exactly at `lastByteOffset` (append guard).
 * Reads bytes from max(0, lastByteOffset - TAIL_BYTES) to lastByteOffset.
 * Returns a hex SHA-256 hash.
 */
export function computeTailAnchorHash(
  filePath: string,
  lastByteOffset: number
): string {
  const start = Math.max(0, lastByteOffset - TAIL_BYTES);
  const bytesToRead = lastByteOffset - start;
  const buf = Buffer.alloc(bytesToRead);
  const fd = openSync(filePath, "r");
  try {
    readSync(fd, buf, 0, bytesToRead, start);
  } finally {
    closeSync(fd);
  }
  return createHash("sha256").update(buf).digest("hex");
}
