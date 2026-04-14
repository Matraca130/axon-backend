/**
 * infographic-image-generator.ts — Instagram infographic generation for summaries
 *
 * Generates educational infographic images (9:16 vertical, Instagram-style)
 * for the most important concepts in a summary. Max 2 images per summary.
 *
 * Uses Gemini 3.1 Flash image generation (via gemini-image.ts).
 * Storage: infographic-images/{institutionId}/{summaryId}/{conceptIndex}.png
 *
 * Style: Cartoon/hand-drawn medical illustrations with expressive characters,
 * soft pastel palette, rounded info boxes. More sober than children's
 * illustrations — aimed at medical students, not kids.
 *
 * Differs from summary-image-generator.ts in:
 *   - Vertical 9:16 format optimized for Instagram/mobile
 *   - Cartoon illustration style (not clinical diagrams)
 *   - Auto-selects top concepts from summary blocks
 *   - Max 2 images per summary (one per concept)
 *   - Branding footer: @axonmed_ + category
 */

import { type SupabaseClient } from "npm:@supabase/supabase-js";
import { generateImage, IMAGE_MODEL } from "./gemini-image.ts";

// ─── Types ──────────────────────────────────────────────────────────

export interface InfographicResult {
  imageUrl: string;
  model: string;
  promptUsed: string;
  conceptTitle: string;
  conceptIndex: number;
}

export interface InfographicRequest {
  summaryId: string;
  institutionId: string;
  topic: string;           // e.g. "Semiología Cardiovascular"
  category: string;        // e.g. "Cardiología", "Farmacología"
  conceptTitle: string;    // Main concept to illustrate
  conceptDescription: string; // Brief explanation of the concept
  keyElements: string[];   // 3-5 sub-elements to show in the infographic
  conceptIndex: number;    // 0 or 1 (max 2 per summary)
  customPrompt?: string;
}

export interface SummaryBlock {
  id: string;
  type: string;
  order_index: number;
  content: Record<string, unknown>;
}

// ─── AXON Infographic Visual Style ──────────────────────────────────

const AXON_INFOGRAPHIC_STYLE = `
FORMATO: Imagen vertical 9:16 (1080x1920 px), optimizada para Instagram.

ESTILO VISUAL:
- Ilustraciones estilo cartoon/dibujo a mano pero SOBRIO y PROFESIONAL — dirigido a estudiantes de medicina, no a niños
- Los conceptos médicos (órganos, células, moléculas) se representan como personajes con personalidad pero con precisión anatómica
- Colores pasteles suaves: rosa pálido, lila/morado claro, celeste, verde menta, melocotón
- Fondo claro (blanco o crema muy suave #FFFAF5)
- Bordes redondeados en las cajas de información
- Líneas limpias, grosor consistente, sin texturas excesivas
- Cada personaje/concepto tiene expresión facial sutil (ojos proporcionados, no kawaii exagerado)

ESTRUCTURA DE LA IMAGEN:
- Título grande y llamativo arriba (fuente bold sans-serif, color oscuro)
- Subtítulo con la especialidad médica
- Secciones claras separadas visualmente con ilustración + texto corto
- Cada sub-concepto tiene: ilustración pequeña + nombre + explicación de 3-5 palabras máximo
- Pie de página con @axonmed_ y la categoría médica

TEXTO:
- TODO en español
- Explicaciones ultra simplificadas y memorables para estudiantes de medicina
- Usa comparaciones médicas relevantes cuando sea posible
- Tipografía clara y legible: sans-serif para cuerpo, bold para títulos
- Máximo 30 palabras de texto total (el resto es visual)

PROHIBIDO:
- Marcas de agua o logos externos
- Texto en inglés
- Fondos oscuros
- Estilo demasiado infantil o kawaii
- Elementos decorativos sin función educativa
- Sangre, gore, o representaciones gráficas perturbadoras
`.trim();

// ─── Concept Selector ───────────────────────────────────────────────

/**
 * Selects the top 2 most important concepts from summary blocks.
 *
 * Priority scoring:
 *   1. key_point blocks (most distilled knowledge) → weight 10
 *   2. comparison blocks (differential diagnosis, contrasts) → weight 8
 *   3. stages blocks (clinical progression, pathophysiology) → weight 7
 *   4. callout blocks with "exam" or "warning" → weight 6
 *   5. prose blocks that lead the summary (order 0-1) → weight 4
 *   6. list_detail, grid, two_column → weight 3
 *
 * Returns max 2 concepts, each with title + description + key elements.
 */
export function selectTopConcepts(
  blocks: SummaryBlock[],
  topicName: string,
): Array<{
  conceptTitle: string;
  conceptDescription: string;
  keyElements: string[];
  blockType: string;
}> {
  type ScoredConcept = {
    score: number;
    conceptTitle: string;
    conceptDescription: string;
    keyElements: string[];
    blockType: string;
  };

  const scored: ScoredConcept[] = [];

  for (const block of blocks) {
    const c = block.content || {};
    const type = block.type;
    const title = (c.title as string) || (c.heading as string) || "";
    const body = (c.body as string) || (c.text as string) || "";
    // deno-lint-ignore no-explicit-any
    const items = (c.items as any[]) || (c.rows as any[]) || [];

    let score = 0;
    let description = "";
    let keyElements: string[] = [];

    switch (type) {
      case "key_point":
        score = 10;
        description = body.slice(0, 120);
        keyElements = [title || "Concepto clave"];
        break;

      case "comparison":
        score = 8;
        description = title || "Comparación diagnóstica";
        // Extract column headers or first items as elements
        keyElements = items
          .slice(0, 4)
          .map((item: Record<string, unknown>) =>
            (item.label as string) || (item.name as string) || String(item),
          )
          .filter(Boolean);
        break;

      case "stages":
        score = 7;
        description = title || "Progresión clínica";
        keyElements = items
          .slice(0, 5)
          .map((item: Record<string, unknown>) =>
            (item.title as string) || (item.name as string) || String(item),
          )
          .filter(Boolean);
        break;

      case "callout":
      case "callout_exam":
      case "callout_warning":
      case "callout_mnemonic":
        score = type.includes("exam") || type.includes("warning") ? 6 : 4;
        description = body.slice(0, 120);
        keyElements = [title || "Punto importante"];
        break;

      case "prose":
        score = block.order_index <= 1 ? 4 : 2;
        description = body.slice(0, 120);
        keyElements = [title || topicName];
        break;

      case "list_detail":
      case "grid":
      case "two_column":
        score = 3;
        description = title || "Detalle clínico";
        keyElements = items
          .slice(0, 4)
          .map((item: Record<string, unknown>) =>
            (item.title as string) || (item.label as string) || String(item),
          )
          .filter(Boolean);
        break;

      default:
        score = 1;
        description = title || body.slice(0, 80);
        keyElements = title ? [title] : [];
    }

    // Skip blocks with no meaningful content
    if (!title && !body && items.length === 0) continue;

    // Boost blocks that have rich structured data
    if (items.length >= 3) score += 2;
    if (title && body) score += 1;

    scored.push({
      score,
      conceptTitle: title || `${topicName} — ${type}`,
      conceptDescription: description,
      keyElements: keyElements.length > 0 ? keyElements : [topicName],
      blockType: type,
    });
  }

  // Sort by score descending, take top 2
  scored.sort((a, b) => b.score - a.score);

  // Avoid duplicates: if top 2 are same type, skip to next different type
  const selected: ScoredConcept[] = [];
  const usedTypes = new Set<string>();

  for (const concept of scored) {
    if (selected.length >= 2) break;
    // Allow same type only if we don't have 2 yet and it's a high-value type
    if (usedTypes.has(concept.blockType) && concept.score < 7) continue;
    selected.push(concept);
    usedTypes.add(concept.blockType);
  }

  return selected;
}

// ─── Prompt Builder ─────────────────────────────────────────────────

export function buildInfographicPrompt(request: InfographicRequest): string {
  if (request.customPrompt?.trim()) {
    return `${request.customPrompt.trim()}\n\n${AXON_INFOGRAPHIC_STYLE}`;
  }

  const elementsText = request.keyElements
    .slice(0, 5)
    .map((el, i) => `${i + 1}. ${el}`)
    .join("\n");

  return [
    `Genera una infografía educativa vertical (9:16) para Instagram.`,
    ``,
    `TEMA PRINCIPAL: ${request.conceptTitle}`,
    `ESPECIALIDAD: ${request.category}`,
    `MATERIA: ${request.topic}`,
    ``,
    `CONCEPTO A ILUSTRAR: ${request.conceptDescription}`,
    ``,
    `ELEMENTOS CLAVE QUE DEBEN APARECER:`,
    elementsText,
    ``,
    `PIE DE PÁGINA: @axonmed_ | ${request.category}`,
    ``,
    AXON_INFOGRAPHIC_STYLE,
  ].join("\n");
}

// ─── Storage ────────────────────────────────────────────────────────

const BUCKET = "infographic-images";

async function ensureBucket(supabase: SupabaseClient): Promise<void> {
  const { data: buckets } = await supabase.storage.listBuckets();
  const exists = buckets?.some((b) => b.name === BUCKET);

  if (!exists) {
    const { error } = await supabase.storage.createBucket(BUCKET, {
      public: true,
      fileSizeLimit: 5 * 1024 * 1024,
      allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
    });
    if (error && !error.message.includes("already exists")) {
      throw new Error(`[Infographic] Failed to create bucket: ${error.message}`);
    }
    console.log(`[Infographic] Created bucket: ${BUCKET}`);
  }
}

// ─── Main Pipeline ──────────────────────────────────────────────────

/**
 * Generate a single infographic image for a concept and upload to Storage.
 *
 * Pipeline:
 *   1. Build infographic prompt with AXON visual style
 *   2. Ensure storage bucket exists
 *   3. Call Gemini 3.1 Flash image generation
 *   4. Upload PNG to Storage (upsert)
 *   5. Return URL + metadata
 */
export async function generateInfographic(
  supabase: SupabaseClient,
  request: InfographicRequest,
): Promise<InfographicResult> {
  const prompt = buildInfographicPrompt(request);

  console.log(
    `[Infographic] Generating concept ${request.conceptIndex} for summary ${request.summaryId}: ` +
    `"${request.conceptTitle}" (prompt length=${prompt.length})`,
  );

  await ensureBucket(supabase);

  const generated = await generateImage({ prompt });

  const storagePath =
    `${request.institutionId}/${request.summaryId}/${request.conceptIndex}.png`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, generated.imageBuffer, {
      contentType: "image/png",
      upsert: true,
    });

  if (uploadError) {
    throw new Error(
      `[Infographic] Storage upload failed: ${uploadError.message}`,
    );
  }

  const { data: publicUrlData } = supabase.storage
    .from(BUCKET)
    .getPublicUrl(storagePath);

  console.log(
    `[Infographic] Done: ${publicUrlData.publicUrl} (${generated.imageBuffer.length} bytes)`,
  );

  return {
    imageUrl: publicUrlData.publicUrl,
    model: IMAGE_MODEL,
    promptUsed: prompt,
    conceptTitle: request.conceptTitle,
    conceptIndex: request.conceptIndex,
  };
}

// ─── Batch Generator ────────────────────────────────────────────────

/**
 * Generate infographics for a summary's top concepts.
 *
 * 1. Reads summary blocks
 * 2. Selects top 2 concepts via scoring algorithm
 * 3. Generates 1 infographic per concept (sequential, not parallel — rate limits)
 * 4. Returns array of results
 */
export async function generateInfographicsForSummary(
  supabase: SupabaseClient,
  summaryId: string,
  institutionId: string,
  topic: string,
  category: string,
  maxImages?: number,
): Promise<InfographicResult[]> {
  const limit = Math.min(maxImages ?? 2, 2); // Hard cap at 2

  // Fetch summary blocks
  const { data: blocks, error: blocksErr } = await supabase
    .from("summary_blocks")
    .select("id, type, order_index, content")
    .eq("summary_id", summaryId)
    .eq("is_active", true)
    .order("order_index", { ascending: true });

  if (blocksErr || !blocks?.length) {
    throw new Error(
      `[Infographic] No blocks found for summary ${summaryId}: ${blocksErr?.message ?? "empty"}`,
    );
  }

  // Select top concepts
  const concepts = selectTopConcepts(blocks as SummaryBlock[], topic);
  const toGenerate = concepts.slice(0, limit);

  console.log(
    `[Infographic] Selected ${toGenerate.length} concepts from ${blocks.length} blocks: ` +
    toGenerate.map((c) => `"${c.conceptTitle}" (${c.blockType})`).join(", "),
  );

  // Generate sequentially (Gemini rate limits)
  const results: InfographicResult[] = [];

  for (let i = 0; i < toGenerate.length; i++) {
    const concept = toGenerate[i];

    const result = await generateInfographic(supabase, {
      summaryId,
      institutionId,
      topic,
      category,
      conceptTitle: concept.conceptTitle,
      conceptDescription: concept.conceptDescription,
      keyElements: concept.keyElements,
      conceptIndex: i,
    });

    results.push(result);
  }

  return results;
}
