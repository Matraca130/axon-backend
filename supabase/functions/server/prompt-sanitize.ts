/**
 * Prompt sanitization utilities for defense against prompt injection.
 * All user-supplied or database-sourced content MUST be sanitized before
 * interpolation into LLM prompts.
 */

/** Strip control characters (except newline/tab) and truncate at word boundary */
export function sanitizeForPrompt(text: string, maxLen = 2000): string {
  // Strip control chars except \n and \t
  let clean = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  if (clean.length <= maxLen) return clean;
  // Truncate at word boundary
  const cutPoint = clean.lastIndexOf(' ', maxLen);
  return (cutPoint > 0 ? clean.slice(0, cutPoint) : clean.slice(0, maxLen)) + '...';
}

/** Wrap content in XML tags to clearly delimit untrusted content in prompts */
export function wrapXml(tag: string, content: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(tag)) {
    throw new Error(`Invalid tag name: ${tag}`);
  }
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escaped = content.replace(new RegExp(`</${escapedTag}>`, 'gi'), `</${tag}[escaped]>`);
  return `<${tag}>\n${escaped}\n</${tag}>`;
}

// PII-SAFE: whitelist only non-identifying pedagogical fields before
// injecting a student profile (e.g. from get_student_knowledge_context RPC)
// into an LLM prompt. Anything like email, full_name, id, user_id, phone
// must never reach Anthropic logs. We walk the RPC output defensively — it
// may be an object with mastery arrays or an array of topic rows, depending
// on schema version.
const PROFILE_ALLOWED_KEYS = new Set([
  "mastery_level",
  "mastery",
  "mastery_levels",
  "topic_count",
  "topics_count",
  "progress",
  "progress_percentage",
  "progress_pct",
  "avg_score",
  "average_score",
  "score",
  "level",
  "strengths",
  "weaknesses",
  "topic_title",
  "topic_name",
  "summary_count",
  "summaries_count",
  "questions_answered",
  "correct_ratio",
  "streak",
]);

const PROFILE_FORBIDDEN_KEYS = new Set([
  "email",
  "full_name",
  "name",
  "first_name",
  "last_name",
  "id",
  "user_id",
  "student_id",
  "phone",
  "phone_number",
  "avatar_url",
  "address",
]);

/**
 * Sanitize a student-profile object before embedding it in an LLM prompt.
 * Recursively descends arrays/objects, drops keys not in the pedagogical
 * allowlist, and explicitly strips known PII keys. Primitive values pass
 * through unchanged.
 */
export function sanitizeProfileForPrompt(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(sanitizeProfileForPrompt);
  }
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (PROFILE_FORBIDDEN_KEYS.has(k)) continue;
      if (!PROFILE_ALLOWED_KEYS.has(k)) continue;
      out[k] = sanitizeProfileForPrompt(v);
    }
    return out;
  }
  return node;
}
