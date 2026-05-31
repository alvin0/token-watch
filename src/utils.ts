import { randomBytes } from "crypto";

/** Generate a cryptographically random nonce for Content-Security-Policy. */
export function getNonce(): string {
  return randomBytes(16).toString("base64");
}
