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
  return `<${tag}>\n${content}\n</${tag}>`;
}
