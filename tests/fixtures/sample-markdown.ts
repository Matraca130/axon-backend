/**
 * tests/fixtures/sample-markdown.ts — Markdown fixtures for chunker unit tests
 *
 * Each fixture is designed to exercise a specific chunking scenario.
 * All content is educational (biology theme) to match Axon's domain.
 *
 * Fase 5 — Issue #30, sub-task 5.3
 */

// ─── SHORT: Fits in a single chunk (~280 chars) ─────────────────────

export const SHORT_MARKDOWN = `# La Célula

La célula es la unidad básica de la vida. Todos los organismos vivos están compuestos por una o más células. Las células contienen material genético (ADN) y son capaces de reproducirse mediante división celular. Existen dos tipos principales: procariotas y eucariotas.`;

// ─── LONG: Multiple h2 sections, some with h3 (~1800 chars) ────────

export const LONG_MARKDOWN = `# Biología Celular

## Mitosis

La mitosis es el proceso de división celular en el que una célula madre se divide para producir dos células hijas genéticamente idénticas. Este proceso es fundamental para el crecimiento y la reparación de tejidos en organismos multicelulares.

La mitosis consta de cuatro fases principales: profase, metafase, anafase y telofase. Durante la profase, la cromatina se condensa para formar cromosomas visibles. En la metafase, los cromosomas se alinean en el plano ecuatorial de la célula.

## Meiosis

La meiosis es un tipo especial de división celular que produce células sexuales (gametos) con la mitad del número de cromosomas de la célula original. Este proceso es esencial para la reproducción sexual.

### Meiosis I

En la primera división meiótica, los cromosomas homólogos se aparean y pueden intercambiar segmentos de ADN mediante un proceso llamado entrecruzamiento o crossing-over. Esta recombinación genética aumenta la diversidad genética de la descendencia. Los cromosomas homólogos se separan durante la anafase I, reduciendo el número cromosómico a la mitad.

### Meiosis II

La segunda división meiótica es similar a la mitosis. Las cromátidas hermanas se separan, produciendo un total de cuatro células haploides a partir de una célula diploide original. Cada célula resultante tiene una combinación única de genes.

## Comparación

Mientras que la mitosis produce dos células diploides idénticas, la meiosis produce cuatro células haploides genéticamente diversas. La mitosis es utilizada para el crecimiento y la reparación, mientras que la meiosis es exclusiva de la formación de gametos en organismos con reproducción sexual.`;

// ─── STRUCTURED: Well-organized with clear hierarchy ────────────────

export const STRUCTURED_MARKDOWN = `# Genética Molecular

## Estructura del ADN

El ácido desoxirribonucleico (ADN) es una molécula que contiene las instrucciones genéticas de todos los organismos vivos. Su estructura fue descubierta por Watson y Crick en 1953.

### Componentes

El ADN está compuesto por nucleótidos. Cada nucleótido tiene tres partes: un grupo fosfato, un azúcar desoxirribosa y una base nitrogenada. Las bases son adenina (A), timina (T), guanina (G) y citosina (C).

### Doble Hélice

Las dos cadenas de ADN se enrollan una alrededor de la otra formando una doble hélice. Las bases se aparean de forma complementaria: A con T, y G con C, mediante puentes de hidrógeno.

## Replicación del ADN

La replicación es el proceso por el cual el ADN se duplica antes de la división celular. La enzima helicasa separa las dos cadenas y la ADN polimerasa sintetiza las nuevas cadenas complementarias.

Este proceso es semiconservativo: cada molécula hija contiene una cadena original y una cadena nueva. La fidelidad de la replicación es muy alta gracias a los mecanismos de corrección de errores de la ADN polimerasa.

## Transcripción

La transcripción es el proceso por el cual la información del ADN se copia a una molécula de ARN mensajero (ARNm). La ARN polimerasa se une al promotor del gen y sintetiza el ARNm en dirección 5' a 3'.`;

// ─── SINGLE LONG PARAGRAPH: No headers, no breaks (~1400 chars) ────
//
// Forces the chunker to split at sentence boundaries (`. `)
// since there are no structural separators (## / ### / \n\n).

export const SINGLE_LONG_PARAGRAPH = `La fotosíntesis es el proceso bioquímico mediante el cual los organismos autótrofos, principalmente plantas, algas y ciertas bacterias, convierten la energía luminosa del sol en energía química almacenada en moléculas de glucosa. Este proceso ocurre principalmente en los cloroplastos, orgánulos celulares que contienen clorofila, el pigmento verde responsable de captar la luz solar. La fotosíntesis se divide en dos fases principales: la fase luminosa y la fase oscura o ciclo de Calvin. Durante la fase luminosa, que ocurre en las membranas tilacoidales, la energía de la luz se utiliza para descomponer moléculas de agua en oxígeno, protones y electrones. Los electrones viajan a través de una cadena de transporte electrónico, generando ATP y NADPH. En la fase oscura, que tiene lugar en el estroma del cloroplasto, el CO2 atmosférico se fija y se reduce utilizando el ATP y NADPH producidos en la fase luminosa. El resultado neto de la fotosíntesis es la conversión de seis moléculas de CO2 y seis moléculas de agua en una molécula de glucosa y seis moléculas de oxígeno. Este proceso es fundamental para la vida en la Tierra, ya que produce el oxígeno que respiramos y constituye la base de casi todas las cadenas alimentarias. Sin la fotosíntesis, la vida tal como la conocemos no sería posible.`;

// ─── EDGE CASES ─────────────────────────────────────────────────────

export const EMPTY_MARKDOWN = "";

export const WHITESPACE_ONLY = "   \n\n   \t  \n  ";

// Very short text that should NOT be split
export const TINY_MARKDOWN = "Hola mundo.";

// Markdown with only headers and minimal content
export const HEADERS_ONLY = `## Sección A

Contenido breve.

## Sección B

Otro párrafo corto.`;

// Text with sentences but no paragraph breaks — tests ". " splitting
export const DENSE_SENTENCES = `La biología es la ciencia que estudia los seres vivos. Abarca desde las moléculas hasta los ecosistemas. Los biólogos investigan la estructura, función, crecimiento, origen, evolución y distribución de los organismos. La biología moderna se divide en numerosas ramas especializadas. Entre ellas se encuentran la genética, la ecología, la microbiología y la bioquímica. Cada rama se enfoca en aspectos específicos de la vida. La investigación biológica ha permitido avances significativos en medicina, agricultura y conservación ambiental. Los métodos de estudio incluyen la observación, la experimentación y el análisis estadístico. La biología molecular ha revolucionado nuestra comprensión de los procesos celulares. El estudio de los genomas completos ha abierto nuevas fronteras en la investigación biomédica.`;
