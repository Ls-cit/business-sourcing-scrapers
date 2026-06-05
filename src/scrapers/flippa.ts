/**
 * Flippa scraper logueado.
 *
 * Estrategia:
 *   1. Playwright lanza Chromium con user-agent realista.
 *   2. Loguea con email + password (NO Google OAuth — bloquea Playwright).
 *      Si el usuario tiene OAuth de Google, debe setear password adicional
 *      en Flippa (ver INSTRUCCIONES — paso preliminar).
 *   3. Verifica que la sesión esté activa.
 *   4. Llama a /v3/listings con cookies de la sesión (browser context las inyecta).
 *   5. Aplica filtros server-side (property_type, price) + client-side (country, status).
 *   6. Normaliza al schema unificado.
 *
 * Anti-ban: delays humanos, user-agent real, viewport real, no múltiples corridas/día.
 */

import { chromium, Browser, BrowserContext } from 'playwright';
import { CONFIG } from '../config.js';
import { log, humanDelay } from '../utils/log.js';
import type { NormalizedListing, ScraperResult } from '../types.js';

const FLIPPA_LOGIN_URL = 'https://flippa.com/login';
const FLIPPA_API_LISTINGS = 'https://flippa.com/v3/listings';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface FlippaApiListing {
  id: string | number;
  title?: string;
  property_name?: string;
  display_price?: number;
  current_price?: number;
  profit_per_month?: number;
  revenue_per_month?: number;
  seller_location?: string;
  established_at?: string;
  status?: string;
  html_url?: string;
  property_type?: string;
  sale_method?: string;
  super_seller?: boolean;
  has_verified_revenue?: boolean;
  has_verified_traffic?: boolean;
  confidential?: boolean;
  [k: string]: unknown;
}

export async function scrapeFlippa(): Promise<ScraperResult> {
  const start = Date.now();
  let requestCount = 0;

  if (!CONFIG.flippa.email || !CONFIG.flippa.password) {
    throw new Error('FLIPPA_EMAIL / FLIPPA_PASSWORD no seteados');
  }

  let browser: Browser | null = null;
  try {
    log.info('Flippa: lanzando browser');
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    const context: BrowserContext = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
    });

    await loginFlippa(context);
    requestCount++;

    log.info('Flippa: fetching listings via API replay');
    const raw = await fetchAllListings(context, () => requestCount++);

    log.info(`Flippa: total raw listings traídos: ${raw.length}`);
    const filtered = applyClientFilters(raw);
    log.info(`Flippa: post-filtro client-side (USA + open): ${filtered.length}`);

    const normalized = filtered.map(toNormalized);

    return {
      source: 'flippa',
      listings: normalized,
      requestCount,
      durationMs: Date.now() - start,
    };
  } finally {
    if (browser) await browser.close();
  }
}

async function loginFlippa(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  log.info('Flippa: navegando a login');
  await page.goto(FLIPPA_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await humanDelay();

  // Detectar el form de login. Flippa usa email + password inputs estándar.
  // Selectores probables — si Flippa los cambia, hay que actualizarlos acá.
  const emailInput = page.locator('input[type="email"], input[name="email"], #user_email').first();
  const passwordInput = page.locator('input[type="password"], input[name="password"], #user_password').first();

  await emailInput.waitFor({ timeout: 10_000 });
  await emailInput.fill(CONFIG.flippa.email!);
  await humanDelay(400, 1200);
  await passwordInput.fill(CONFIG.flippa.password!);
  await humanDelay(400, 1200);

  // Submit
  const submitBtn = page.locator('button[type="submit"], input[type="submit"]').first();
  await submitBtn.click();

  // Wait for navigation or some logged-in indicator
  try {
    await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 20_000 });
    log.info(`Flippa: login OK, URL actual: ${page.url()}`);
  } catch {
    throw new Error('Flippa: login no completó (URL sigue en /login). ¿Password incorrecto, 2FA, captcha?');
  }

  await page.close();
}

async function fetchAllListings(
  context: BrowserContext,
  onRequest: () => void
): Promise<FlippaApiListing[]> {
  const all: FlippaApiListing[] = [];
  const PAGE_SIZE = 100;
  let page = 1;
  let total = Infinity;

  while (all.length < total) {
    const url =
      `${FLIPPA_API_LISTINGS}?` +
      `filter[property_type]=${encodeURIComponent(CONFIG.flippa.filters.propertyType)}` +
      `&filter[price][min]=${CONFIG.flippa.filters.priceMin}` +
      `&filter[price][max]=${CONFIG.flippa.filters.priceMax}` +
      `&page[size]=${PAGE_SIZE}` +
      `&page[number]=${page}`;

    log.info(`Flippa: GET page ${page}`);
    onRequest();
    const resp = await context.request.get(url, {
      headers: { Accept: 'application/json' },
    });
    if (resp.status() !== 200) {
      throw new Error(`Flippa API ${url} → HTTP ${resp.status()}`);
    }
    const json = (await resp.json()) as { meta?: { total_results?: number }; data?: FlippaApiListing[] };
    total = json.meta?.total_results ?? all.length;
    const items = json.data ?? [];
    if (items.length === 0) break;
    all.push(...items);
    page++;
    if (page > 100) break; // safety

    await humanDelay(1500, 3500);
  }

  return all;
}

function applyClientFilters(rows: FlippaApiListing[]): FlippaApiListing[] {
  return rows.filter((r) => {
    if (CONFIG.flippa.filters.onlyOpen && r.status !== 'open') return false;
    if (CONFIG.flippa.filters.country && r.seller_location !== CONFIG.flippa.filters.country) return false;
    return true;
  });
}

function toNormalized(r: FlippaApiListing): NormalizedListing {
  const price = typeof r.display_price === 'number' ? r.display_price :
                typeof r.current_price === 'number' ? r.current_price : null;
  const monthlyProfit = typeof r.profit_per_month === 'number' ? r.profit_per_month : null;
  const monthlyRevenue = typeof r.revenue_per_month === 'number' ? r.revenue_per_month : null;
  const multipleYears =
    price && monthlyProfit && monthlyProfit > 0
      ? Math.round((price / (monthlyProfit * 12)) * 10) / 10
      : null;
  const ageYears = computeAgeYears(r.established_at);

  return {
    source: 'flippa',
    listing_id: String(r.id),
    title: String(r.title || r.property_name || ''),
    asking_price: price,
    monthly_profit: monthlyProfit,
    monthly_revenue: monthlyRevenue,
    multiple_years: multipleYears,
    location: String(r.seller_location || ''),
    category: String(r.property_name || r.property_type || ''),
    age_years: ageYears,
    status: String(r.status || ''),
    url: String(r.html_url || `https://flippa.com/${r.id}`),
    broker_name: '',
    broker_email: '',
    broker_phone: '',
    raw_json: JSON.stringify(r),
  };
}

function computeAgeYears(iso?: string): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const ms = Date.now() - d.getTime();
  return Math.floor(ms / (365.25 * 24 * 3600 * 1000));
}
