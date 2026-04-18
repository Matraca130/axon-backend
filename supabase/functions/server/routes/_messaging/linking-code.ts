/**
 * routes/_messaging/linking-code.ts — Shared linking-code primitives
 *
 * Used by Telegram and WhatsApp account linking flows.
 *
 * SEC-AUDIT FIX: 10-digit codes (10^10 ≈ 2^33) replace the previous 6-digit
 * codes (10^6) which were brute-forceable against the global session pool.
 * Generation uses rejection sampling to avoid modulo bias.
 */

export const CODE_LENGTH = 10;

/**
 * Generate a cryptographically-random 10-digit numeric code.
 * Zero-padded to exactly CODE_LENGTH characters.
 *
 * Rejection sampling: `limit = 2^64 - (2^64 % 10^10)` is a multiple of
 * 10^10, so `value % 10^10` is uniformly distributed. Rejection rate is
 * ~2×10⁻¹⁰ — practically never triggers a second iteration.
 */
export function generateLinkingCode(): string {
  const max = 10_000_000_000n; // 10^10
  const limit = (1n << 64n) - ((1n << 64n) % max);
  while (true) {
    const buf = new Uint32Array(2);
    crypto.getRandomValues(buf);
    const value = (BigInt(buf[0]) << 32n) | BigInt(buf[1]);
    if (value < limit) {
      return (value % max).toString().padStart(CODE_LENGTH, "0");
    }
  }
}

/** Returns true if `text` is exactly CODE_LENGTH decimal digits (after trim). */
export function isLinkingCode(text: string): boolean {
  return new RegExp(`^\\d{${CODE_LENGTH}}$`).test(text.trim());
}
