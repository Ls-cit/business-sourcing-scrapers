/**
 * Transworld Business Advisors — broker scraper (S2: Broker).
 *
 * tworld.com es Laravel Sanctum. El endpoint /api/listings es PÚBLICO
 * (no requiere login), solo necesita un XSRF-TOKEN obtenido de /sanctum/csrf-cookie.
 *
 * Flow:
 *   1. GET /sanctum/csrf-cookie → captura cookie XSRF-TOKEN
 *   2. POST /api/listings con paginación + filtros server-side (country=US, price min/max)
 *   3. Iterar páginas (9 por página, ~59 páginas para 525 listings)
 *   4. Keyword filter en heading + categories (Transworld no tiene categoría "SaaS")
 *   5. Map a NormalizedListing
 *
 * Decisión: no usamos las credenciales TWORLD_EMAIL/PASSWORD — la API es pública.
 * Quedan cargadas como secret por si algún día cierran el endpoint.
 */

import { CONFIG } from '../../config.js';
import { log, humanDelay } from '../../utils/log.js';
import { matchesTechKeyword } from '../../utils/techKeywords.js';
import type { NormalizedListing, ScraperResult } from '../../types.js';

const BASE = 'https://www.tworld.com';
const CSRF_URL = `${BASE}/sanctum/csrf-cookie`;
const LISTINGS_URL = `${BASE}/api/listings`;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MAX_PAGES = 100; // safety cap
const COUNTRY_US = { value: 4, name: 'United States' };

interface ApiListing {
  image?: string;
  heading: string;
  categories: string; // JSON-encoded array como string, ej. '["Engineering"]'
  slug: string;
  tribe_slug: string;
  industry?: string | null;
  currency_symbol?: string;
  location: string;
  price: number;
  down_payment_price?: number;
  seller_discretionary_earnings?: number;
}

interface ApiResponse {
  status: number;
  success: boolean;
  data: ApiListing[];
  pagination: {
    count: number;
    total: number;
    perPage: number;
    currentPage: number;
    totalPages: number;
    links?: { next?: string };
  };
}

interface SessionCookies {
  xsrfToken: string; // decoded value, ready para X-XSRF-TOKEN header
  cookieHeader: string; // raw "name=value; name=value" para Cookie header
}

export async function scrapeTworld(): Promise<ScraperResult> {
  const start = Date.now();
  let requestCount = 0;

  log.info('[Tworld] start');

  // 1. Init session — get XSRF cookie
  const session = await initSession();
  requestCount++;
  log.info('[Tworld] session initialized');

  // 2. Paginate /api/listings
  const min = CONFIG.flippa.filters.priceMin;
  const max = CONFIG.flippa.filters.priceMax;
  const allListings: ApiListing[] = [];
  let totalPages = 1;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const resp = await fetchListings(session, page, min, max);
    requestCount++;
    if (!resp.data || resp.data.length === 0) break;
    allListings.push(...resp.data);
    totalPages = resp.pagination?.totalPages ?? 1;
    log.info(
      `[Tworld] page ${page}/${totalPages}: +${resp.data.length} (total acum: ${allListings.length})`
    );
    if (page >= totalPages) break;
    await humanDelay(800, 1800);
  }
  log.info(`[Tworld] scraped ${allListings.length} listings (US, $${min}-$${max})`);

  // 3. Keyword filter on heading + categories
  const filtered = allListings.filter((l) => {
    const categoriesText = decodeCategoriesString(l.categories).join(' ');
    return matchesTechKeyword(l.heading, categoriesText, l.industry || '');
  });
  log.info(`[Tworld] post-keyword filter: ${filtered.length}`);

  // 4. Map to NormalizedListing
  const listings: NormalizedListing[] = filtered.map((l) => {
    const sde = l.seller_discretionary_earnings ?? null;
    const monthlyProfit = sde != null ? Math.round(sde / 12) : null;
    const multipleYears =
      l.price && sde && sde > 0 ? Math.round((l.price / sde) * 10) / 10 : null;
    const cats = decodeCategoriesString(l.categories);

    return {
      source: 'tworld',
      listing_id: l.slug,
      title: l.heading,
      asking_price: l.price ?? null,
      monthly_profit: monthlyProfit,
      monthly_revenue: null, // Transworld no expone revenue en este endpoint
      multiple_years: multipleYears,
      location: l.location || '',
      category: cats.join(', '),
      age_years: null,
      status: 'Active',
      url: buildListingUrl(l.tribe_slug, l.slug),
      broker_name: 'Transworld Business Advisors',
      broker_email: '',
      broker_phone: '',
      raw_json: JSON.stringify(l),
    };
  });

  return {
    source: 'tworld',
    listings,
    requestCount,
    durationMs: Date.now() - start,
  };
}

// ============================== Auth (Laravel Sanctum) ==============================

async function initSession(): Promise<SessionCookies> {
  const resp = await fetch(CSRF_URL, {
    method: 'GET',
    headers: { 'User-Agent': UA, Accept: '*/*' },
  });
  if (!resp.ok) {
    throw new Error(`Tworld CSRF init: HTTP ${resp.status}`);
  }
  const setCookies = parseAllSetCookies(resp);
  const xsrfRaw = setCookies.get('XSRF-TOKEN');
  if (!xsrfRaw) {
    throw new Error('Tworld CSRF init: no XSRF-TOKEN cookie en response');
  }
  const xsrfToken = decodeURIComponent(xsrfRaw);
  const cookieHeader = [...setCookies.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  return { xsrfToken, cookieHeader };
}

async function fetchListings(
  session: SessionCookies,
  page: number,
  priceMin: number,
  priceMax: number
): Promise<ApiResponse> {
  const body = {
    page,
    per_page: null,
    country: COUNTRY_US,
    state: { value: null, name: 'All' },
    region: { value: null, name: 'All' },
    categories: [], // sin filtro de categoría — traemos todo el rango y filtramos por keyword
    sub_category: null,
    price_min: { value: priceMin, name: String(priceMin) },
    price_max: { value: priceMax, name: String(priceMax) },
    down_payment_min: null,
    down_payment_max: null,
    discretionary_earnings_min: null,
    discretionary_earnings_max: null,
    franchisee_operation: null,
    relocatable: null,
    real_estate_available: null,
    real_estate_included: null,
    lender_prequalified: null,
    sort: { value: '-c_listing_price__c', name: 'Price ($$$ to $)' },
    tribe_slug: null,
    assigned_to: null,
    parent_slug: null,
  };

  const resp = await fetch(LISTINGS_URL, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-XSRF-TOKEN': session.xsrfToken,
      Cookie: session.cookieHeader,
      Origin: BASE,
      Referer: `${BASE}/businesses-for-sale`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok && resp.status !== 201) {
    const text = await resp.text();
    throw new Error(
      `Tworld /api/listings page ${page}: HTTP ${resp.status} body=${text.slice(0, 200)}`
    );
  }
  return (await resp.json()) as ApiResponse;
}

// ============================== Helpers ==============================

/**
 * Parsea TODOS los Set-Cookie headers de una response.
 * Node fetch combina múltiples Set-Cookie en una sola header string separada por coma,
 * pero el separador "," puede aparecer también dentro del valor (ej. expires=...).
 * Usamos response.headers.getSetCookie() (Node ≥ 18.13) para obtener array.
 */
function parseAllSetCookies(resp: Response): Map<string, string> {
  const result = new Map<string, string>();
  // @ts-ignore — getSetCookie existe en Node 18.13+ pero el types puede no incluirlo
  const rawSetCookies: string[] | undefined =
    typeof resp.headers.getSetCookie === 'function'
      ? resp.headers.getSetCookie()
      : undefined;

  const list = rawSetCookies ?? (() => {
    // fallback: una sola header concatenada
    const combined = resp.headers.get('set-cookie');
    return combined ? [combined] : [];
  })();

  for (const cookieStr of list) {
    const [pair] = cookieStr.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name) result.set(name, value);
  }
  return result;
}

/**
 * Transworld serializa el array de categorías como string JSON dentro del campo:
 *   "categories": "[\"Engineering\",\"Construction\"]"
 * Lo deserializamos defensivamente.
 */
function decodeCategoriesString(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function buildListingUrl(tribeSlug: string, slug: string): string {
  if (!tribeSlug || !slug) return BASE;
  // URL format observado: https://www.tworld.com/locations/{tribe_slug}/listings/{slug}
  // Nota: el tribe_slug "newportbeach" o similar va sin paréntesis ni espacios.
  return `${BASE}/locations/${tribeSlug}/listings/${slug}`;
}
