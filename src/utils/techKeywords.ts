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
  'tech',
  'software',
  'legacy software',
];

const KEYWORD_REGEX = (() => {
  const escaped = KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('\\b(?:' + escaped.join('|') + ')\\b', 'i');
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
