/**
 * Inbar Group — broker scraper (S2: Broker).
 *
 * Sitio WordPress público (inbargroup.com), sin login, sin anti-bot challenge.
 * No tienen categoría dedicada a tech — hay que scrapear todos y filtrar por keyword.
 *
 * Card markup (todo en la listings page):
 *   <div class="listing-box">
 *     <a class="" href="...">Title</a>
 *     <span class="price-description-value">$X</span>
 *     <span class="description-name">Industry:</span> <span class="description-value">X</span>
 *     <span class="description-name">Location:</span> <span class="description-value">X</span>
 *     <span class="description-name">Listing ID:</span> <span class="description-value">X</span>
 *     <span class="description-name">Cash Flow:</span> <span class="description-value">$X</span>
 *     <span class="description-name">Gross Revenue:</span> <span class="description-value">$X</span>
 *     <div class="new-button">NEW</div> / <div class="under-contract-button">UNDER CONTRACT</div>
 *
 * Filtros: precio → status activo (no UNDER CONTRACT/SOLD/LOI) → US-only → keyword tech.
 */

import { CONFIG } from '../../config.js';
import { log } from '../../utils/log.js';
import { matchesTechKeyword } from '../../utils/techKeywords.js';
import { isUSLocation } from '../../utils/usLocation.js';
import type { NormalizedListing, ScraperResult } from '../../types.js';

const LISTINGS_URL = 'https://inbargroup.com/businesses-for-sale/';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface CardData {
  url: string;
  title: string;
  status: string;
  asking_price: number | null;
  industry: string;
  location: string;
  listing_id: string;
  cash_flow_annual: number | null;
  gross_revenue_annual: number | null;
}

export async function scrapeInbarGroup(): Promise<ScraperResult> {
  const start = Date.now();
  let requestCount = 0;

  log.info('[Inbar] start');

  const html = await httpText(LISTINGS_URL);
  requestCount++;
  const cards = parseCards(html);
  log.info(`[Inbar] parsed ${cards.length} cards`);

  // Filter price
  const min = CONFIG.flippa.filters.priceMin;
  const max = CONFIG.flippa.filters.priceMax;
  const inRange = cards.filter(
    (c) => c.asking_price != null && c.asking_price >= min && c.asking_price <= max
  );
  log.info(`[Inbar] in price range $${min}-$${max}: ${inRange.length}`);

  // Descartar listings no-activos. Inbar tiene marcadores en status badge y/o en título.
  const INACTIVE_RE = /\b(UNDER CONTRACT|UNDER LOI|SOLD|PENDING|CLOSED)\b/i;
  const active = inRange.filter((c) =>
    !INACTIVE_RE.test(c.status) && !INACTIVE_RE.test(c.title)
  );
  log.info(`[Inbar] post-status filter (activos): ${active.length}`);

  // US-only (location puede ser una ciudad NYC/Brooklyn o estado)
  const usOnly = active.filter((c) => isUSLocation(c.location) || isUSCity(c.location));
  log.info(`[Inbar] post-USA filter: ${usOnly.length}`);

  // Keyword filter (tech)
  const filtered = usOnly.filter((c) =>
    matchesTechKeyword(c.title, c.industry)
  );
  log.info(`[Inbar] post-keyword filter: ${filtered.length}`);

  const listings: NormalizedListing[] = filtered.map((c) => {
    const monthlyProfit = c.cash_flow_annual != null ? Math.round(c.cash_flow_annual / 12) : null;
    const monthlyRevenue =
      c.gross_revenue_annual != null ? Math.round(c.gross_revenue_annual / 12) : null;
    const multipleYears =
      c.asking_price && c.cash_flow_annual && c.cash_flow_annual > 0
        ? Math.round((c.asking_price / c.cash_flow_annual) * 10) / 10
        : null;

    return {
      source: 'inbargroup',
      listing_id: c.listing_id || urlSlug(c.url),
      title: c.title,
      asking_price: c.asking_price,
      monthly_profit: monthlyProfit,
      monthly_revenue: monthlyRevenue,
      multiple_years: multipleYears,
      location: c.location,
      category: c.industry,
      age_years: null,
      status: c.status || 'Active',
      url: c.url,
      broker_name: 'Inbar Group',
      broker_email: '',
      broker_phone: '',
      raw_json: JSON.stringify(c),
    };
  });

  return {
    source: 'inbargroup',
    listings,
    requestCount,
    durationMs: Date.now() - start,
  };
}

// ============================== Parsing ==============================

function parseCards(html: string): CardData[] {
  const chunks = html.split('<div class="listing-box">').slice(1);
  const out: CardData[] = [];

  for (const chunk of chunks) {
    // URL + title
    const titleMatch = chunk.match(
      /<div class="listing-title">[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/i
    );
    if (!titleMatch) continue;
    const url = titleMatch[1].trim();
    const title = decodeHtml(titleMatch[2].trim());

    // Status badge: <div class="X-button">LABEL</div> (new-button, active-button, under-contract-button, etc.)
    const statusMatch = chunk.match(/<div class="([a-z-]+)-button">([^<]+)<\/div>/i);
    const status = statusMatch ? statusMatch[2].trim() : '';

    // Price
    const priceMatch = chunk.match(/<span class="price-description-value">\$?([\d,]+)/);
    const asking_price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, ''), 10) : null;

    // descriptionName/Value pairs — Industry, Location, Listing ID, Cash Flow, Gross Revenue
    const industry = extractDescriptionByName(chunk, 'Industry');
    const location = extractDescriptionByName(chunk, 'Location');
    const listing_id = extractDescriptionByName(chunk, 'Listing ID');
    const cf = extractDescriptionByName(chunk, 'Cash Flow');
    const rev = extractDescriptionByName(chunk, 'Gross Revenue');
    const cash_flow_annual = cf ? parseMoneyOrNull(cf) : null;
    const gross_revenue_annual = rev ? parseMoneyOrNull(rev) : null;

    out.push({
      url,
      title,
      status,
      asking_price,
      industry,
      location,
      listing_id,
      cash_flow_annual,
      gross_revenue_annual,
    });
  }
  return out;
}

function extractDescriptionByName(chunk: string, name: string): string {
  // <span class="description-name">FIELD:</span> <span class="description-value">VALUE</span>
  const re = new RegExp(
    `<span class="description-name">${escapeRegex(name)}\\s*:?\\s*<\\/span>\\s*<span class="description-value">([^<]*)<\\/span>`,
    'i'
  );
  const m = chunk.match(re);
  return m ? decodeHtml(m[1].trim()) : '';
}

function parseMoneyOrNull(s: string): number | null {
  const m = s.replace(/\s/g, '').match(/\$?([\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
}

// ============================== Helpers ==============================

/**
 * Algunas locations de Inbar son ciudades sin estado (ej. "Brooklyn", "NYC").
 * Esta heurística matchea algunas comunes para US — agregar más si surge.
 */
function isUSCity(loc: string): boolean {
  if (!loc) return false;
  const l = loc.toLowerCase();
  const US_CITY_HINTS = [
    'brooklyn', 'nyc', 'manhattan', 'queens', 'bronx', 'staten island',
    'long island', 'westchester', 'philly', 'philadelphia',
    'chicago', 'la ', 'los angeles', 'sf ', 'san francisco', 'boston',
    'denver', 'seattle', 'atlanta', 'miami', 'dallas', 'houston', 'austin',
    'phoenix', 'portland', 'minneapolis', 'cleveland', 'detroit',
  ];
  return US_CITY_HINTS.some((c) => l.includes(c));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeHtml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8211;/g, '–')
    .replace(/&hellip;/g, '…');
}

function urlSlug(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.split('/').filter(Boolean).pop() || '';
  } catch {
    return url;
  }
}

async function httpText(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.9',
    },
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} en ${url}`);
  }
  return resp.text();
}
