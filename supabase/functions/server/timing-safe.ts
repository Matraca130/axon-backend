/**
 * timing-safe.ts — Constant-time string comparison for Axon v4.4
 *
 * Prevents timing attacks on signature verification by ensuring
 * comparison time is independent of where strings differ.
 *
 * N-10 FIX: Used in Stripe webhook signature verification.
 */

/**
 * Constant-time comparison of two strings.
 * Returns true only if both strings are identical.
 * Comparison time depends only on string length, not content.
 *
 * Security: even if an attacker can measure response times with
 * microsecond precision, they cannot determine which byte differs
 * because ALL bytes are always compared via XOR accumulation.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);

  let result = 0;
  for (let i = 0; i < aBuf.length; i++) {
    result |= aBuf[i] ^ bBuf[i];
  }

  return result === 0;
}
