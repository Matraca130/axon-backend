/**
 * routes/billing/stripe-client.ts — Stripe API client for Axon v4.4
 *
 * Extracted from routes-billing.ts (PR #103) for modularity.
 * Provides a minimal Stripe REST client (no SDK dependency).
 *
 * Exports:
 *   getStripe()      — Lazy-initialized Stripe client singleton
 *   encodeFormData() — Recursive form-data encoder for Stripe API
 */

// ─── Stripe Client (lazy init) ───────────────────────────────────

let _stripe: any = null;

export const getStripe = () => {
  if (_stripe) return _stripe;
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  _stripe = {
    _key: key,
    async request(method: string, path: string, body?: Record<string, unknown>) {
      const url = `https://api.stripe.com/v1${path}`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      const options: RequestInit = { method, headers, signal: controller.signal };
      if (body) {
        options.body = encodeFormData(body);
      }
      try {
        const res = await fetch(url, options);
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.error?.message ?? `Stripe API error: ${res.status}`);
        }
        return data;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
  return _stripe;
};

// ─── Form Data Encoder ───────────────────────────────────────────

export function encodeFormData(obj: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === "object" && !Array.isArray(value)) {
      parts.push(encodeFormData(value as Record<string, unknown>, fullKey));
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === "object") {
          parts.push(encodeFormData(item as Record<string, unknown>, `${fullKey}[${i}]`));
        } else {
          parts.push(`${encodeURIComponent(`${fullKey}[${i}]`)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else {
      parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.filter(Boolean).join("&");
}
