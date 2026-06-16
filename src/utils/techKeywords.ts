/**
 * Filtro genérico de keywords tech compartido por todos los broker adapters.
 *
 * Lista canónica aprobada por Fran (2026-06):
 *   SaaS · tech · software · legacy software
 *
 * Aplica como OR — si CUALQUIER keyword matchea en title/description/industry,
 * el listing pasa. Match case-insensitive con word-boundary para evitar
 * falsos positivos de substrings.
 *
 * Razón de ser: cada broker tiene su propia taxonomía sin estándar (Tech / IT /
 * Software / Legacy / etc.). En vez de adaptar a cada uno, filtramos sobre el
 * texto libre.
 */

const KEYWORDS = [
  'SaaS',
  'Software as a Service',
  'tech',           // standalone "tech" como palabra
  'technology',     // forma sustantiva — matchea "Technology"
  'software',
  'legacy software',
];

/**
 * Patrón:
 *   - SaaS / Software as a Service / legacy software → word boundary estricto
 *   - tech / technology / software → permite prefijos (EdTech, FinTech, biotech)
 *     pero requiere boundary al final (no "techie", "technical-foo")
 *
 * Esto matchea: "EdTech", "FinTech", "Technology", "Software", "tech-enabled".
 * No matchea: "technical writer", "techie person".
 */
const KEYWORD_REGEX = (() => {
  // Para "tech", "technology", "software" permitimos prefijo (ej. EdTech)
  // Para frases multi-word, exigimos word boundary completo
  const parts = [
    '\\bSaaS\\b',
    '\\bSoftware as a Service\\b',
    '\\blegacy software\\b',
    'tech\\b',          // EdTech, FinTech, tech ✓ ; techie ✗
    'technology\\b',    // Technology, biotechnology ✓
    'software\\b',      // Software ✓
  ];
  return new RegExp('(?:' + parts.join('|') + ')', 'i');
})();

/**
 * Devuelve true si alguno de los textos contiene un keyword tech.
 * Pasale title, description, industry, category — todo lo que sea texto libre.
 */
export function matchesTechKeyword(...texts: Array<string | null | undefined>): boolean {
  for (const t of texts) {
    if (t && KEYWORD_REGEX.test(t)) return true;
  }
  return false;
}

export const TECH_KEYWORDS = KEYWORDS;
