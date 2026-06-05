/**
 * Entry point — orquesta el scrapeo por source y la persistencia en Sheets.
 *
 * Uso:
 *   tsx src/index.ts flippa       # solo Flippa
 *   tsx src/index.ts all          # todos los configurados (hoy solo flippa)
 *
 * Output:
 *   - Upsert listings al tab Scraper_Inflow
 *   - Append fila al tab Run_Log
 *   - Si N corridas seguidas fallaron → email
 *   - Exit code 0 si todo OK, 1 si error
 */

import { scrapeFlippa } from './scrapers/flippa.js';
import { upsertListings, appendRunLog } from './sheets/writer.js';
import { maybeNotifyFailure } from './notify/email.js';
import { log } from './utils/log.js';
import type { Source, ScraperResult, RunLogEntry } from './types.js';

interface ScraperFn {
  (): Promise<ScraperResult>;
}

const SCRAPERS: Record<Source, ScraperFn> = {
  flippa: scrapeFlippa,
  // bizscout: scrapeBizScout, // TODO: módulo 2
  bizscout: () => { throw new Error('BizScout aún no implementado'); },
};

async function runOne(source: Source): Promise<{ ok: boolean; message: string }> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let entry: RunLogEntry = {
    timestamp: startedAt,
    source,
    duration_seconds: 0,
    listings_total: 0,
    listings_new: 0,
    listings_updated: 0,
    status: 'error',
    error_message: '',
  };

  try {
    log.info(`=== ${source} START ===`);
    const result = await SCRAPERS[source]();
    log.info(`${source}: scraping done, ${result.listings.length} listings, ${result.requestCount} requests, ${Math.round(result.durationMs / 1000)}s`);

    const upsert = await upsertListings(result.listings);
    log.info(`${source}: upsert done — ${upsert.inserted} insertados, ${upsert.updated} actualizados`);

    entry = {
      ...entry,
      duration_seconds: Math.round((Date.now() - t0) / 1000),
      listings_total: upsert.total,
      listings_new: upsert.inserted,
      listings_updated: upsert.updated,
      status: 'success',
      error_message: '',
    };
    await appendRunLog(entry);
    log.info(`=== ${source} OK ===`);
    return { ok: true, message: '' };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(`${source} failed`, err);
    entry = {
      ...entry,
      duration_seconds: Math.round((Date.now() - t0) / 1000),
      status: 'error',
      error_message: errMsg,
    };
    try {
      await appendRunLog(entry);
    } catch (logErr) {
      log.error('No se pudo escribir en Run_Log tampoco', logErr);
    }
    try {
      await maybeNotifyFailure(source, errMsg);
    } catch (notifyErr) {
      log.error('Falló el notify por email', notifyErr);
    }
    return { ok: false, message: errMsg };
  }
}

async function main() {
  const arg = process.argv[2] || 'all';
  const sources: Source[] =
    arg === 'all'
      ? ['flippa'] // ampliar cuando se sume bizscout
      : (arg.split(',') as Source[]);

  let anyFailed = false;
  for (const src of sources) {
    if (!(src in SCRAPERS)) {
      log.error(`Source desconocida: ${src}`);
      anyFailed = true;
      continue;
    }
    const { ok } = await runOne(src);
    if (!ok) anyFailed = true;
  }

  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  log.error('Uncaught fatal', err);
  process.exit(1);
});
