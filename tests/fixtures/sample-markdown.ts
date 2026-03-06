/**
 * tests/fixtures/sample-markdown.ts — Test fixtures for chunker tests
 *
 * Provides various markdown inputs for testing the chunker:
 *   - Short text (< maxChunkSize)
 *   - Long text with h2/h3 headers
 *   - Single long paragraph
 *   - Edge cases (empty, whitespace, etc.)
 *
 * Fase 5 — Issue #30, sub-task 5.3
 */

// ─── Short text: should produce 1 chunk ────────────────────────
export const SHORT_MARKDOWN = `# Introducción

Este es un texto corto que cabe en un solo chunk sin problemas.
Tiene solo unas pocas líneas y no necesita splitting.`;

// ─── Medium text with h2 sections ──────────────────────────────
export const H2_SECTIONS_MARKDOWN = `# Biología Celular

## Mitosis

La mitosis es el proceso de división celular que resulta en dos células hijas idénticas a la célula madre. Este proceso es fundamental para el crecimiento y la reparación de tejidos en los organismos multicelulares. Durante la mitosis, el material genético se duplica y se distribuye equitativamente entre las dos nuevas células. La mitosis consta de varias fases que aseguran la correcta separación del material genético.

## Meiosis

La meiosis es un tipo especial de división celular que produce células sexuales o gametos. A diferencia de la mitosis, la meiosis reduce el número de cromosomas a la mitad, generando células haploides. Este proceso es esencial para la reproducción sexual y contribuye a la variabilidad genética de las especies.

### Meiosis I

En la primera división meiótica, los cromosomas homólogos se emparejan y pueden intercambiar segmentos de ADN en un proceso llamado entrecruzamiento o crossing-over. Esto aumenta la diversidad genética. Los cromosomas homólogos se separan, reduciendo el número de cromosomas a la mitad.

### Meiosis II

La segunda división meiótica es similar a la mitosis. Las cromátidas hermanas se separan, produciendo cuatro células haploides. Cada una de estas células tiene una combinación única de genes, lo que contribuye a la variabilidad genética de la descendencia.`;

// ─── Long single paragraph (no headers, no double newlines) ────
export const LONG_PARAGRAPH_MARKDOWN = `La fotosíntesis es un proceso bioquímico fundamental que realizan las plantas, algas y algunas bacterias para convertir la energía luminosa del sol en energía química. Este proceso ocurre principalmente en los cloroplastos de las células vegetales, donde la clorofila absorbe la luz solar. La fotosíntesis se divide en dos fases principales: la fase luminosa y la fase oscura o ciclo de Calvin. Durante la fase luminosa, la energía solar se utiliza para dividir moléculas de agua, liberando oxígeno como subproducto y generando ATP y NADPH. Estos compuestos energéticos son luego utilizados en la fase oscura para fijar el dióxido de carbono atmosférico y convertirlo en glucosa. La ecuación general de la fotosíntesis es: 6CO2 + 6H2O + luz → C6H12O6 + 6O2. Este proceso es vital no solo para las plantas sino para toda la vida en la Tierra, ya que produce el oxígeno que respiramos y forma la base de la mayoría de las cadenas alimentarias. Sin la fotosíntesis, la vida tal como la conocemos no sería posible. Las plantas han desarrollado diversas adaptaciones para optimizar la fotosíntesis en diferentes condiciones ambientales, como las plantas C4 y CAM que son más eficientes en climas cálidos y secos.`;

// ─── Text with mixed headers (h2 + h3 + paragraphs) ───────────
export const MIXED_HEADERS_MARKDOWN = `# Química Orgánica

## Hidrocarburos

Los hidrocarburos son compuestos químicos formados únicamente por átomos de carbono e hidrógeno. Se clasifican en saturados e insaturados según el tipo de enlace entre los átomos de carbono.

### Alcanos

Los alcanos son hidrocarburos saturados con enlaces simples. Siguen la fórmula general CnH2n+2. Son relativamente poco reactivos y se utilizan como combustibles.

### Alquenos

Los alquenos contienen al menos un doble enlace carbono-carbono. Son más reactivos que los alcanos y participan en reacciones de adición.

## Grupos Funcionales

Los grupos funcionales son agrupaciones de átomos dentro de una molécula orgánica que determinan sus propiedades químicas. Los más importantes incluyen: hidroxilo (-OH), carboxilo (-COOH), amino (-NH2), y carbonilo (C=O).

### Alcoholes

Los alcoholes contienen el grupo hidroxilo (-OH) unido a un carbono saturado. Se clasifican en primarios, secundarios y terciarios según el número de carbonos unidos al carbono que porta el grupo -OH.

### Ácidos Carboxílicos

Los ácidos carboxílicos contienen el grupo funcional carboxilo (-COOH). Son ácidos débiles pero más fuertes que los alcoholes. Son fundamentales en bioquímica, formando parte de aminoácidos y ácidos grasos.`;

// ─── Very short text (edge case) ──────────────────────────────
export const VERY_SHORT_MARKDOWN = `Hola mundo.`;

// ─── Empty strings ────────────────────────────────────────────
export const EMPTY_MARKDOWN = "";
export const WHITESPACE_MARKDOWN = "   \n\n  \t  \n  ";

// ─── Text that should trigger sentence-level splitting ────────
export const DENSE_PARAGRAPH_MARKDOWN = `## Genética Molecular

El ADN es una molécula que contiene las instrucciones genéticas. Está formado por dos cadenas complementarias que se enrollan en una doble hélice. Cada cadena está compuesta por nucleótidos que contienen una base nitrogenada, un azúcar desoxirribosa y un grupo fosfato. Las bases nitrogenadas son adenina, timina, guanina y citosina. La adenina siempre se empareja con la timina mediante dos puentes de hidrógeno. La guanina siempre se empareja con la citosina mediante tres puentes de hidrógeno. Esta complementariedad de bases es fundamental para la replicación del ADN. Durante la replicación, las dos cadenas se separan y cada una sirve como molde para sintetizar una nueva cadena complementaria. La enzima ADN polimerasa cataliza la adición de nucleótidos a la nueva cadena. El resultado son dos moléculas de ADN idénticas a la original. Este proceso es semiconservativo porque cada nueva molécula conserva una cadena original y tiene una cadena nueva. Los errores durante la replicación se corrigen mediante mecanismos de reparación del ADN. Sin embargo, algunos errores pueden persistir y dar lugar a mutaciones.`;
