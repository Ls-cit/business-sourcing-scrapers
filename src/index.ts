/**
 * Entry point — orquesta el scrapeo, review de NDAs y firma automática.
 *
 * Uso:
 *   tsx src/index.ts flippa       # solo scrape Task 1 (Flippa)
 *   tsx src/index.ts all          # scrape todos los configurados
 *   tsx src/index.ts nda          # solo Task 2 + 3 (review + sign de NDAs pendientes)
 *   tsx src/index.ts pipeline     # Task 1 + Task 2 + Task 3 (corrida completa)
 *
 * Output:
 *   - Upsert listings al tab Scraper_Inflow
 *   - Update NDA fields per-listing
 *   - Append fila al tab Run_Log
 *   - Email de pushback (per listing 🟡/🔴) + email de alerta si N fails seguidos
 *   - Exit code 0 si todo OK, 1 si error
 */

import { scrapeFlippa } from './scrapers/flippa.js';
import { scrapeIndianaEquityBrokers } from './scrapers/brokers/indianaequitybrokers.js';
import { scrapeSynergyBB } from './scrapers/brokers/synergybb.js';
import { upsertListings, appendRunLog } from './sheets/writer.js';
import { maybeNotifyFailure } from './notify/email.js';
import { processNdaQueue, processSignPendingGreens } from './nda/process.js';
import { log } from './utils/log.js';
import type { Source, ScraperResult, RunLogEntry } from './types.js';

interface ScraperFn {
  (): Promise<ScraperResult>;
}

const SCRAPERS: Record<Source, ScraperFn> = {
  flippa: scrapeFlippa,
  bizscout: () => { throw new Error('BizScout aún no implementado'); },
  indianaequitybrokers: scrapeIndianaEquityBrokers,
  synergybb: scrapeSynergyBB,
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
    try { await appendRunLog(entry); } catch (e) { log.error('append run log failed', e); }
    try { await maybeNotifyFailure(source, errMsg); } catch (e) { log.error('notify failed', e); }
    return { ok: false, message: errMsg };
  }
}

async function runNdaPipeline(): Promise<{ ok: boolean; message: string }> {
  const t0 = Date.now();
  try {
    log.info(`=== NDA pipeline START ===`);
    const result = await processNdaQueue();
    const dur = Math.round((Date.now() - t0) / 1000);
    log.info(`=== NDA pipeline OK — ${dur}s — ${JSON.stringify(result)} ===`);
    return { ok: true, message: '' };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error('NDA pipeline failed', err);
    return { ok: false, message: errMsg };
  }
}

async function main() {
  const arg = process.argv[2] || 'pipeline';
  let anyFailed = false;

  if (arg === 'nda') {
    const r = await runNdaPipeline();
    if (!r.ok) anyFailed = true;
  } else if (arg === 'sign-greens') {
    try {
      log.info('=== sign-greens START ===');
      const r = await processSignPendingGreens();
      log.info(`=== sign-greens OK — ${JSON.stringify(r)} ===`);
    } catch (err) {
      log.error('sign-greens failed', err);
      anyFailed = true;
    }
  } else if (
    arg === 'pipeline' ||
    arg === 'all' ||
    arg === 'flippa' ||
    arg === 'indianaequitybrokers' ||
    arg === 'synergybb'
  ) {
    // Sources scope
    let sources: Source[];
    if (arg === 'flippa') sources = ['flippa'];
    else if (arg === 'indianaequitybrokers') sources = ['indianaequitybrokers'];
    else if (arg === 'synergybb') sources = ['synergybb'];
    else sources = ['flippa', 'indianaequitybrokers', 'synergybb']; // all + pipeline
    for (const src of sources) {
      const { ok } = await runOne(src);
      if (!ok) anyFailed = true;
    }
    // Pipeline runs NDA processing después del scraping
    if (arg === 'pipeline') {
      const r = await runNdaPipeline();
      if (!r.ok) anyFailed = true;
    }
  } else {
    log.error(`Comando desconocido: ${arg}. Usá: flippa | all | nda | pipeline`);
    process.exit(2);
  }

  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  log.error('Uncaught fatal', err);
  process.exit(1);
});
