/**
 * block-fixtures.ts — Test fixtures for block-flatten and block-hook tests
 *
 * Provides typed block structures for all 10 educational block types,
 * 2 legacy types (text, heading), and edge cases.
 *
 * Fase 4, TASK_1
 */

// ─── Types ──────────────────────────────────────────────────────

export interface TestBlock {
  type: string;
  content: Record<string, unknown>;
  order_index: number;
}

// ─── Fixtures ───────────────────────────────────────────────────

export const BLOCKS: Record<string, TestBlock> = {
  // ── 10 Educational Block Types ────────────────────────────────

  prose: {
    type: "prose",
    content: {
      title: "Anatomía del SNC",
      body: "El {{sistema nervioso central}} está compuesto por el {{encéfalo}} y la médula espinal. Las neuronas transmiten señales eléctricas.",
    },
    order_index: 0,
  },

  key_point: {
    type: "key_point",
    content: {
      title: "Sinapsis Neuronal",
      body: "La sinapsis es el punto de comunicación entre dos neuronas. La transmisión puede ser eléctrica o química.",
      importance: "critical",
    },
    order_index: 1,
  },

  stages: {
    type: "stages",
    content: {
      title: "Proceso de Mielinización",
      items: [
        { label: "Fase 1", description: "Proliferación de {{oligodendrocitos}}", severity: "high" },
        { label: "Fase 2", description: "Envolvimiento del axón por la vaina de mielina", severity: "medium" },
        { label: "Fase 3", description: "Compactación y maduración de la vaina", severity: "low" },
      ],
    },
    order_index: 2,
  },

  comparison: {
    type: "comparison",
    content: {
      title: "SNC vs SNP",
      headers: ["Característica", "SNC", "SNP"],
      rows: [
        ["Ubicación", "Cráneo y columna", "Resto del cuerpo"],
        ["Mielinización", "Oligodendrocitos", "Células de Schwann"],
        ["Regeneración", "Limitada", "Posible"],
      ],
    },
    order_index: 3,
  },

  list_detail: {
    type: "list_detail",
    content: {
      intro: "Los principales neurotransmisores incluyen:",
      items: [
        { term: "Dopamina", detail: "Regula el placer y la motivación" },
        { term: "Serotonina", detail: "Modula el estado de ánimo y el sueño" },
        { term: "GABA", detail: "Principal neurotransmisor inhibitorio" },
      ],
    },
    order_index: 4,
  },

  grid: {
    type: "grid",
    content: {
      title: "Lóbulos Cerebrales",
      items: [
        { label: "Frontal", detail: "Funciones ejecutivas y motoras" },
        { label: "Parietal", detail: "Procesamiento sensorial" },
        { label: "Temporal", detail: "Audición y memoria" },
        { label: "Occipital", detail: "Procesamiento visual" },
      ],
    },
    order_index: 5,
  },

  two_column: {
    type: "two_column",
    content: {
      left: {
        title: "Neurona Motora",
        body: "Transmite impulsos desde el SNC hacia los músculos y glándulas.",
      },
      right: {
        title: "Neurona Sensorial",
        body: "Transmite impulsos desde los receptores sensoriales hacia el SNC.",
      },
    },
    order_index: 6,
  },

  callout_tip: {
    type: "callout",
    content: {
      variant: "tip",
      title: "Dato Clínico",
      body: "La esclerosis múltiple es causada por la desmielinización del SNC.",
    },
    order_index: 7,
  },

  callout_warning: {
    type: "callout",
    content: {
      variant: "warning",
      title: "Precaución",
      body: "No confundir nervios craneales con nervios espinales.",
    },
    order_index: 8,
  },

  callout_exam: {
    type: "callout",
    content: {
      variant: "exam",
      title: "Pregunta de Examen",
      body: "¿Cuál es la función principal del cerebelo?",
    },
    order_index: 9,
  },

  callout_no_title: {
    type: "callout",
    content: {
      variant: "tip",
      body: "Recuerda revisar los pares craneales antes del examen.",
    },
    order_index: 10,
  },

  image_reference: {
    type: "image_reference",
    content: {
      src: "https://example.com/neuron.png",
      alt: "Diagrama de una neurona típica",
      caption: "Estructura de la neurona con sus partes principales",
    },
    order_index: 11,
  },

  section_divider: {
    type: "section_divider",
    content: {
      label: "Sección: Médula Espinal",
    },
    order_index: 12,
  },

  section_divider_empty: {
    type: "section_divider",
    content: {},
    order_index: 13,
  },

  // ── 2 Legacy Types ────────────────────────────────────────────

  legacy_text: {
    type: "text",
    content: {
      html: "<p>Este es un <strong>texto legado</strong> con <em>HTML</em> que debe ser limpiado.</p><br/><p>Segundo párrafo.</p>",
    },
    order_index: 14,
  },

  legacy_heading: {
    type: "heading",
    content: {
      text: "Título Legado del Resumen",
      level: 2,
    },
    order_index: 15,
  },

  // ── Edge Cases ────────────────────────────────────────────────

  unknown_type: {
    type: "future_block_v99",
    content: {
      foo: "bar",
      nested: { deep: true },
    },
    order_index: 16,
  },

  null_content: {
    type: "prose",
    content: null as unknown as Record<string, unknown>,
    order_index: 17,
  },

  undefined_content: {
    type: "prose",
    content: undefined as unknown as Record<string, unknown>,
    order_index: 18,
  },
};

// ─── Helper ─────────────────────────────────────────────────────

/**
 * Build an ordered block list from fixture keys.
 * Assigns sequential order_index values (0, 1, 2, ...).
 */
export function makeBlockList(...keys: string[]): TestBlock[] {
  return keys.map((key, i) => {
    const block = BLOCKS[key];
    if (!block) throw new Error(`Unknown fixture key: ${key}`);
    return { ...block, order_index: i };
  });
}
