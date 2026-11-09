import { createHash, timingSafeEqual } from "node:crypto";

export function secretsAreEqual(first: string, second: string): boolean {
  const firstDigest = createHash("sha256").update(first).digest();
  const secondDigest = createHash("sha256").update(second).digest();
  return timingSafeEqual(firstDigest, secondDigest);
}
