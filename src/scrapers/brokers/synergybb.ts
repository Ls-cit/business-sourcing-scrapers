/**
 * Synergy Business Brokers — broker scraper (S2: Broker).
 *
 * Sitio WordPress público, sin login, sin anti-bot challenge.
 * Tienen una categoría dedicada a tech: /industries/tech-businesses-for-sale/
 * Apuntamos directo a esa página para no traer 200 listings de otras industrias.
 *
 * Card markup (todo está en la listings page, no necesitamos detail fetch):
 *   <a class="sale-list-item-title" href="...">Title</a>
 *   <div class="sale-list-item-price">$X</div>
 *   <span>Annual Revenue: <strong>$X</strong></span>
 *   <span>Net Cash Flow: <strong>$X</strong></span>
 *   <div class="sale-list-item-content-dsec">description</div>
 *   <div class="sale-list-category">[Category1, Category2]</div>
 *   <div class="sale-list-location-btn"><h6>State</h6></div>
 */

import { CONFIG } from '../../config.js';
import { log } from '../../utils/log.js';
import { matchesTechKeyword } from '../../utils/techKeywords.js';
import type { NormalizedListing, ScraperResult } from '../../types.js';

const TECH_LISTINGS_URL = 'https://synergybb.com/industries/tech-businesses-for-sale/';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface CardData {
  url: string;
  title: string;
  asking_price: number | null;
  annual_revenue: number | null;
  net_cash_flow: number | null;
  description: string;
  categories: string[];
  location: string;
}

export async function scrapeSynergyBB(): Promise<ScraperResult> {
  const start = Date.now();
  let requestCount = 0;

  log.info('[Synergy] start');

  const html = await httpText(TECH_LISTINGS_URL);
  requestCount++;
  const cards = parseCards(html);
  log.info(`[Synergy] parsed ${cards.length} cards from tech category page`);

  // Filter price
  const min = CONFIG.flippa.filters.priceMin;
  const max = CONFIG.flippa.filters.priceMax;
  const inRange = cards.filter(
    (c) => c.asking_price != null && c.asking_price >= min && c.asking_price <= max
  );
  log.info(`[Synergy] in price range $${min}-$${max}: ${inRange.length}`);

  // Descartar listings con marcador "SOLD" / "Has Accepted Offer" en el título
  // (Synergy los deja visibles en la categoría tech como showcase histórico).
  const SOLD_RE = /\b(SOLD|Has Accepted Offer|Under Offer)\b/i;
  const notSold = inRange.filter((c) => !SOLD_RE.test(c.title));
  log.info(`[Synergy] post-SOLD filter: ${notSold.length}`);

  // Filtro USA por location (las cards tienen "Texas" / "United States" / "Asia" / etc.).
  const usOnly = notSold.filter((c) => isUSLocation(c.location));
  log.info(`[Synergy] post-USA filter: ${usOnly.length}`);

  // Keyword filter (safety net — category page should already be tech)
  const filtered = usOnly.filter((c) =>
    matchesTechKeyword(c.title, c.description, c.categories.join(' '))
  );
  log.info(`[Synergy] post-keyword filter: ${filtered.length}`);

  const listings: NormalizedListing[] = filtered.map((c) => {
    const monthlyProfit = c.net_cash_flow != null ? Math.round(c.net_cash_flow / 12) : null;
    const monthlyRevenue = c.annual_revenue != null ? Math.round(c.annual_revenue / 12) : null;
    const multipleYears =
      c.asking_price && c.net_cash_flow && c.net_cash_flow > 0
        ? Math.round((c.asking_price / c.net_cash_flow) * 10) / 10
        : null;

    return {
      source: 'synergybb',
      listing_id: urlSlug(c.url),
      title: c.title,
      asking_price: c.asking_price,
      monthly_profit: monthlyProfit,
      monthly_revenue: monthlyRevenue,
      multiple_years: multipleYears,
      location: c.location,
      category: c.categories.join(', '),
      age_years: null,
      status: 'Active',
      url: c.url,
      broker_name: 'Synergy Business Brokers',
      broker_email: '',
      broker_phone: '',
      raw_json: JSON.stringify(c),
    };
  });

  return {
    source: 'synergybb',
    listings,
    requestCount,
    durationMs: Date.now() - start,
  };
}

// ============================== Parsing ==============================

function parseCards(html: string): CardData[] {
  const chunks = html.split('<div class="sale-list-item-content">').slice(1);
  const out: CardData[] = [];

  for (const chunk of chunks) {
    const titleMatch = chunk.match(
      /<a[^>]*href="([^"]+)"[^>]*class="sale-list-item-title"[^>]*>([^<]+)<\/a>/i
    );
    if (!titleMatch) continue;

    const url = titleMatch[1].trim();
    const title = decodeHtml(titleMatch[2].trim());

    const priceMatch = chunk.match(/sale-list-item-price">\$?([\d,]+)/);
    const asking_price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, ''), 10) : null;

    const revMatch = chunk.match(/Annual Revenue:\s*<strong>\$?([\d,]+)/i);
    const annual_revenue = revMatch ? parseInt(revMatch[1].replace(/,/g, ''), 10) : null;

    const cfMatch = chunk.match(/Net Cash Flow:\s*<strong>\$?([\d,]+)/i);
    const net_cash_flow = cfMatch ? parseInt(cfMatch[1].replace(/,/g, ''), 10) : null;

    const descMatch = chunk.match(/<div class="sale-list-item-content-dsec">([\s\S]*?)<\/div>/i);
    const description = descMatch
      ? decodeHtml(stripTags(descMatch[1]).replace(/\s+/g, ' ').trim())
      : '';

    // Categories: list of <a> inside sale-list-category
    const catBlock = chunk.match(/<div class="sale-list-category">([\s\S]*?)<\/div>/i);
    const categories: string[] = [];
    if (catBlock) {
      const catLinks = catBlock[1].matchAll(/<a[^>]*>([^<]+)<\/a>/gi);
      for (const m of catLinks) categories.push(decodeHtml(m[1].trim()));
    }

    // Location: <h6><i ... ></i> State </h6> inside sale-list-location-btn
    const locMatch = chunk.match(
      /<div class="sale-list-location-btn">[\s\S]*?<h6>(?:<i[^>]*><\/i>)?\s*([^<]+)<\/h6>/i
    );
    const location = locMatch ? decodeHtml(locMatch[1].trim()) : '';

    out.push({
      url,
      title,
      asking_price,
      annual_revenue,
      net_cash_flow,
      description,
      categories,
      location,
    });
  }
  return out;
}

// ============================== Filtros ==============================

/**
 * Devuelve true si la location pinta como US.
 * Acepta: "United States", "USA", o cualquier estado de los 50 (full name).
 * Rechaza: "Asia", "Singapore", "India", "Canada", etc.
 */
function isUSLocation(loc: string): boolean {
  if (!loc) return false;
  const l = loc.toLowerCase();
  if (l.includes('united states') || l.includes('usa')) return true;
  // Match contra los 50 estados (lowercase, palabra completa)
  const US_STATES = [
    'alabama','alaska','arizona','arkansas','california','colorado','connecticut',
    'delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa',
    'kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan',
    'minnesota','mississippi','missouri','montana','nebraska','nevada',
    'new hampshire','new jersey','new mexico','new york','north carolina',
    'north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island',
    'south carolina','south dakota','tennessee','texas','utah','vermont',
    'virginia','washington','west virginia','wisconsin','wyoming',
  ];
  return US_STATES.some((s) => new RegExp('\\b' + s + '\\b', 'i').test(l));
}

// ============================== Helpers ==============================

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

function decodeHtml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
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
