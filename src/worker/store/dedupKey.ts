import { createHash } from "node:crypto";

/**
 * Characters of base64url kept from the digest: 16 characters carry 96 bits.
 *
 * At the ten million records a very heavy user might reach, the chance of any
 * two keys colliding is about 1 in 10^15 — far below the chance of the disk
 * losing the row instead. A collision would replace one turn with another, so
 * the migration that shortens existing keys checks for one explicitly rather
 * than trusting the arithmetic.
 */
const KEY_CHARS = 16;

/**
 * The form a dedup key takes inside the database.
 *
 * In memory a key stays readable and structured — `claude:<session>:<file
 * scope>:<request>:<group start>` — because the ingest path splits it to
 * recognise keys written by older releases. On disk none of that is ever read
 * back: the column is a primary key, joined to `tool_event.record_dedup_key`
 * and compared for equality, and nothing else. Storing seventy bytes of
 * structure that no query looks inside cost 32 MB on a 122 MB database, most of
 * it in the primary-key index and the tool-event rows that repeat the key.
 *
 * Hashing happens here, at the boundary, rather than where keys are built, so
 * every caller upstream keeps working with the readable form.
 */
export function storageKey(dedupKey: string): string {
  return createHash("sha256").update(dedupKey).digest("base64url").slice(0, KEY_CHARS);
}
