import { createHash, randomBytes } from "node:crypto";

const SECRET_BYTES = 32;
const CANONICAL_SECRET = /^[A-Za-z0-9_-]{43}$/;

export function generateOpaqueSecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

export function isCanonicalOpaqueSecret(secret: unknown): secret is string {
  if (typeof secret !== "string" || !CANONICAL_SECRET.test(secret)) return false;
  // Node's decoder accepts padding/aliases; only the exact unpadded round-trip is valid.
  const decoded = Buffer.from(secret, "base64url");
  return decoded.length === SECRET_BYTES && decoded.toString("base64url") === secret;
}

export function hashOpaqueSecret(secret: string): Buffer {
  if (!isCanonicalOpaqueSecret(secret)) throw new TypeError("Secreto opaco invalido");
  // Hash the external canonical UTF-8 string, NOT the decoded random bytes.
  return createHash("sha256").update(secret, "utf8").digest();
}
