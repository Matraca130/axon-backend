/**
 * routes/ai/chat/constants.ts — Tuning constants for the RAG chat pipeline
 *
 * Extracted from routes/ai/chat.ts during the chat-split refactor
 * (refactor/chat-split-modules). These values were previously inlined
 * as magic numbers throughout the route handler. Consolidating them
 * here makes the tuning surface discoverable and diff-friendly:
 * changing a threshold no longer requires scanning 600 lines of prompt
 * assembly / search plumbing.
 *
 * Pure extraction — every value matches the behavior of chat.ts at
 * commit 72fc071 (cutover). No logic change.
 */

// --- Query shape --------------------------------------------------

/**
 * Character count under which a user message is considered a "short"
 * query (typically acronyms like "EIC", "HTA", "ECG"). Short queries
 * get a relaxed similarity threshold because their dense-vector
 * signal is weak and we want the hybrid search's lexical component
 * to carry more weight.
 */
export const SHORT_QUERY_CHAR_THRESHOLD = 15;

// --- Similarity thresholds ----------------------------------------

/**
 * Minimum cosine similarity for a chunk to count as a match when the
 * user query is short (see SHORT_QUERY_CHAR_THRESHOLD). Relaxed from
 * the normal threshold so the lexical half of hybrid search can
 * surface chunks that the dense vector alone would reject.
 */
export const SHORT_QUERY_SIMILARITY_THRESHOLD = 0.15;

/**
 * Default minimum cosine similarity for a chunk to count as a match
 * on normal-length queries. Applied to both the hybrid search RPC
 * and the coarse-to-fine search RPC.
 */
export const NORMAL_QUERY_SIMILARITY_THRESHOLD = 0.3;

/**
 * If the top merged match already clears this similarity score AND
 * there are 3 or fewer merged matches, skip Claude-as-Judge re-ranking.
 * Rationale: re-ranking is expensive and adds latency; when the top
 * result is already very confident, the LLM judge rarely changes the
 * order enough to justify the extra call.
 */
export const RERANK_HIGH_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Re-ranking is also triggered when the number of merged matches
 * exceeds this count, regardless of top similarity. Below this many
 * results there's little to re-order.
 */
export const RERANK_MIN_RESULTS = 3;

// --- Vector search RPC limits -------------------------------------

/**
 * Max rows to request from rag_hybrid_search (p_match_count) and
 * from rag_coarse_to_fine_search (p_top_chunks). Governs how wide the
 * retrieval candidate pool is before merge + re-rank.
 */
export const MAX_SEARCH_RESULTS = 8;

/**
 * rag_coarse_to_fine_search p_top_summaries: number of summaries the
 * coarse (summary-level) stage keeps before drilling down into their
 * chunks. Kept small so the fine stage doesn't fan out into the
 * entire corpus.
 */
export const COARSE_TO_FINE_TOP_SUMMARIES = 3;

// --- Result processing -------------------------------------------

/**
 * How many of the top merged matches the Claude-as-Judge re-ranker
 * receives and scores. The re-ranker returns these in its adjusted
 * order.
 */
export const RERANK_TOP_K = 5;

/**
 * How many of the final merged/re-ranked matches are used as the
 * primary anchors for context assembly (and therefore for adjacent
 * chunk expansion). More than 5 starts to crowd the prompt without
 * improving answer quality.
 */
export const CONTEXT_PRIMARY_MATCHES = 5;

/**
 * Phase 5 adjacent-chunk expansion: cap on how many distinct summary
 * groups we fetch neighbors for. Prevents the adjacent-fetch query
 * from fanning out across every summary in a large merged result set.
 */
export const ADJACENT_FETCH_MAX_SUMMARIES = 3;

// --- Prompt shaping (sanitize caps) -------------------------------

/**
 * Max character length of the user message — both as a validation
 * limit on the incoming request and as the sanitize cap feeding the
 * <user_message> prompt tag. Kept as a single constant so the two
 * never drift out of sync.
 */
export const MAX_MESSAGE_LENGTH = 2000;

/**
 * Max character length of the serialized conversation history after
 * sanitization. Feeds the <conversation_history> prompt tag.
 */
export const MAX_HISTORY_CONTEXT_CHARS = 3000;

/**
 * Max character length of the assembled RAG context (course content)
 * after sanitization. Feeds the <course_content> prompt tag. This
 * is the prompt-shaping sibling of context-assembly.ts's
 * MAX_CONTEXT_CHARS (which caps the raw assembled string before it
 * ever reaches the sanitizer).
 */
export const MAX_RAG_CONTEXT_CHARS = 6000;

// --- Conversation history handling --------------------------------

/**
 * How many of the most recent history turns the route keeps. Older
 * turns are dropped before augmentation and prompt assembly, both to
 * control token budget and to bound cost per request.
 */
export const MAX_HISTORY_TURNS = 6;

/**
 * Per-turn character cap applied when copying history entries into
 * the working array. A defense-in-depth trim against oversized
 * individual history messages.
 */
export const MAX_HISTORY_TURN_CHARS = 500;

// --- LLM generation parameters ------------------------------------

/**
 * Temperature for the Claude generation call in both streaming and
 * non-streaming paths. 0.5 balances factual grounding (we're answering
 * from retrieved context) against natural phrasing.
 */
export const CHAT_TEMPERATURE = 0.5;

/**
 * Max output tokens for the Claude generation call in both streaming
 * and non-streaming paths.
 */
export const CHAT_MAX_TOKENS = 2500;
