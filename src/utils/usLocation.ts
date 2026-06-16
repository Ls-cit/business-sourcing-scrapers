/**
 * Heurística US — comparte entre broker adapters.
 * Devuelve true si la location pinta como US:
 *   - "United States" / "USA" como substring
 *   - Cualquier nombre de los 50 estados como palabra completa
 *   - Cualquier abreviatura de estado de 2 letras separada con coma (ej. ", NJ")
 */

const US_STATE_NAMES = [
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut',
  'delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa',
  'kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan',
  'minnesota','mississippi','missouri','montana','nebraska','nevada',
  'new hampshire','new jersey','new mexico','new york','north carolina',
  'north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island',
  'south carolina','south dakota','tennessee','texas','utah','vermont',
  'virginia','washington','west virginia','wisconsin','wyoming',
];

const US_STATE_ABBR = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY',
];

const NAME_REGEX = new RegExp('\\b(?:' + US_STATE_NAMES.join('|') + ')\\b', 'i');
const ABBR_REGEX = new RegExp('(?:^|,\\s*)(?:' + US_STATE_ABBR.join('|') + ')\\b');

export function isUSLocation(loc: string | null | undefined): boolean {
  if (!loc) return false;
  const l = loc.trim();
  if (!l) return false;
  if (/united states|\bUSA\b|\bU\.S\.\b/i.test(l)) return true;
  if (NAME_REGEX.test(l)) return true;
  if (ABBR_REGEX.test(l)) return true;
  return false;
}
