/**
 * Indiana Equity Brokers — broker scraper (S2: Broker).
 *
 * Sitio WordPress público, sin login, sin anti-bot challenge.
 * - Listings page: una sola página HTML con todos los listings visibles.
 * - Card markup: <div class="listingBox"> con title, location, internal ID y precio.
 * - Detail page: agrega Gross Revenue + SDE (cash flow) que la card no tiene.
 *
 * Estrategia (eficiente):
 *   1. Fetch listings page → parsear 26 cards.
 *   2. Filtro de precio (CONFIG.filters.priceMin/Max).
 *   3. Solo para los que pasan precio → fetch detail page para obtener SDE + Revenue.
 *   4. Filtro de keyword tech sobre title + industry.
 *   5. Map a NormalizedListing.
 */

import { CONFIG } from '../../config.js';
import { log, humanDelay } from '../../utils/log.js';
import { matchesTechKeyword } from '../../utils/techKeywords.js';
import type { NormalizedListing, ScraperResult } from '../../types.js';

const LISTINGS_URL = 'https://indianaequitybrokers.com/businesses-for-sale/';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface CardData {
  url: string;
  title: string;
  status: string;        // ACTIVE / NEW / etc.
  industry: string;
  location: string;
  internal_id: string;
  asking_price: number | null;
}

interface DetailData {
  gross_revenue: number | null;
  sde: number | null;
  asking_price_confirmed: number | null;
}

export async function scrapeIndianaEquityBrokers(): Promise<ScraperResult> {
  const start = Date.now();
  let requestCount = 0;

  log.info('[IEB] start');

  // 1) Listings page
  const html = await httpText(LISTINGS_URL);
  requestCount++;
  const cards = parseCards(html);
  log.info(`[IEB] parsed ${cards.length} cards from listings page`);

  // 2) Filter price
  const min = CONFIG.flippa.filters.priceMin;
  const max = CONFIG.flippa.filters.priceMax;
  const inRange = cards.filter((c) => c.asking_price != null && c.asking_price >= min && c.asking_price <= max);
  log.info(`[IEB] in price range $${min}-$${max}: ${inRange.length}`);

  // 3) For each in-range listing, enrich with detail page (Gross Revenue + SDE)
  const enriched: Array<CardData & Partial<DetailData>> = [];
  for (const card of inRange) {
    try {
      const detailHtml = await httpText(card.url);
      requestCount++;
      const detail = parseDetail(detailHtml);
      enriched.push({ ...card, ...detail });
      await humanDelay(800, 1800);
    } catch (err) {
      log.warn(`[IEB] detail fetch failed for ${card.url}: ${String(err)}`);
      enriched.push({ ...card });
    }
  }

  // 4) Tech keyword filter on title + industry
  const filtered = enriched.filter((c) =>
    matchesTechKeyword(c.title, c.industry)
  );
  log.info(`[IEB] post-keyword filter: ${filtered.length}`);

  // 5) Map to NormalizedListing
  const listings: NormalizedListing[] = filtered.map((c) => {
    const sde = c.sde ?? null;
    const monthlyProfit = sde != null ? Math.round(sde / 12) : null;
    const monthlyRevenue = c.gross_revenue != null ? Math.round(c.gross_revenue / 12) : null;
    const askingPrice = c.asking_price_confirmed ?? c.asking_price;
    const multipleYears =
      askingPrice && sde && sde > 0 ? Math.round((askingPrice / sde) * 10) / 10 : null;

    return {
      source: 'indianaequitybrokers',
      listing_id: c.internal_id || urlSlug(c.url),
      title: c.title,
      asking_price: askingPrice,
      monthly_profit: monthlyProfit,
      monthly_revenue: monthlyRevenue,
      multiple_years: multipleYears,
      location: c.location,
      category: c.industry,
      age_years: null,
      status: c.status || 'Active',
      url: c.url,
      broker_name: 'Indiana Equity Brokers',
      broker_email: '',
      broker_phone: '',
      raw_json: JSON.stringify(c),
    };
  });

  return {
    source: 'indianaequitybrokers',
    listings,
    requestCount,
    durationMs: Date.now() - start,
  };
}

// ============================== Parsing ==============================

function parseCards(html: string): CardData[] {
  const chunks = html.split('<div class="listingBox">').slice(1);
  const out: CardData[] = [];

  for (const chunk of chunks) {
    // URL + title
    const titleMatch = chunk.match(
      /<div class="listingTitle">[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>[\s\S]*?<h2>([^<]+)<\/h2>/i
    );
    if (!titleMatch) continue;
    const url = titleMatch[1].trim();
    const title = decodeHtml(titleMatch[2].trim());

    // Status badge — newButton / activeButton / etc.
    const statusMatch = chunk.match(/<div class="(\w+)Button">([^<]+)<\/div>/);
    const status = statusMatch ? statusMatch[2].trim() : '';

    // Industry / Location / Internal ID — via class+descriptionValue pattern
    const industry = extractDescription(chunk, 'listingIndustry');
    const location = extractDescription(chunk, 'listingLocation');
    const internalId = extractDescription(chunk, 'internalID');

    // Price
    const priceMatch = chunk.match(/<span class="priceDescriptionValue">\$?([\d,]+)<\/span>/);
    const asking_price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, ''), 10) : null;

    out.push({
      url,
      title,
      status,
      industry,
      location,
      internal_id: internalId,
      asking_price,
    });
  }
  return out;
}

function extractDescription(chunk: string, parentClass: string): string {
  const re = new RegExp(
    `<div class="${parentClass}">[\\s\\S]*?<span class="descriptionValue">([^<]+)<\\/span>`,
    'i'
  );
  const m = chunk.match(re);
  return m ? decodeHtml(m[1].trim()) : '';
}

function parseDetail(html: string): DetailData {
  // SDE + Asking Price están en <span class="twcSummaryBoxValue">$X</span>
  // El layout es: <span class="twcSummaryBoxName">FIELD</span> ... <span class="twcSummaryBoxValue">VALUE</span>
  const sde = extractSummaryValue(html, 'SDE');
  const asking = extractSummaryValue(html, 'Asking Price');

  // Gross Revenue está en class "descriptionValue" después de "Gross Revenue" en descriptionName
  const revMatch = html.match(
    /<span class="descriptionName">Gross Revenue<\/span>[\s\S]{0,500}?<span class="descriptionValue">\$?([\d,]+)<\/span>/i
  );
  const gross_revenue = revMatch ? parseInt(revMatch[1].replace(/,/g, ''), 10) : null;

  return {
    sde,
    gross_revenue,
    asking_price_confirmed: asking,
  };
}

function extractSummaryValue(html: string, fieldName: string): number | null {
  // <span class="twcSummaryBoxName">Asking Price</span> ... <span class="twcSummaryBoxValue">$270,000</span>
  const re = new RegExp(
    `<span class="twcSummaryBoxName">${fieldName}<\\/span>[\\s\\S]{0,500}?<span class="twcSummaryBoxValue">\\$?([\\d,]+)<\\/span>`,
    'i'
  );
  const m = html.match(re);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
}

// ============================== Helpers ==============================

function decodeHtml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
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
