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
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);

  const maxLen = Math.max(aBuf.length, bBuf.length);
  let result = aBuf.length ^ bBuf.length;
  for (let i = 0; i < maxLen; i++) {
    const aByte = i < aBuf.length ? aBuf[i] : 0;
    const bByte = i < bBuf.length ? bBuf[i] : 0;
    result |= aByte ^ bByte;
  }

  return result === 0;
}
