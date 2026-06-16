/**
 * Google Sheets writer — apunta al Dealflow canónico de la SSOT.
 *
 * Arquitectura dual:
 *   - Tab "Dealflow" (existe, 27 cols A:AA) — schema canónico de Francisco.
 *     Escribimos solo las cols que vienen de scraping; las cols editadas por
 *     humanos (Reason Killed, Vault Note, Notes, etc.) se preservan en updates.
 *   - Tab "Scraper_State" (lo creamos nosotros) — estado interno: dedup keys,
 *     raw_json, NDA flags. Joineado a Dealflow vía col A "#" (ID canónico).
 *
 * Dedup determinístico (Paso A del skill `screen-broker`):
 *   - URL slug match → mismo deal
 *   - Listing ID match → mismo deal
 */

import { google, sheets_v4 } from 'googleapis';
import { JWT } from 'google-auth-library';
import { CONFIG } from '../config.js';
import { log } from '../utils/log.js';
import type { NormalizedListing, RunLogEntry, Source, NdaVerdict } from '../types.js';

// ========================== Schemas ==========================

const DEALFLOW_HEADERS = [
  '#',              // A
  'Deal Name',      // B
  'Source_Type',    // C
  'Sub-source',     // D
  'Broker/Contact', // E
  'URL',            // F
  'Geography',      // G
  'Established',    // H
  'Revenue',        // I (anual)
  'SDE',            // J (anual)
  'Asking Price',   // K
  'Asking/Revenue', // L (múltiplo revenue)
  'Asking/SDE',     // M (múltiplo SDE)
  'Status',         // N
  'Deal-box Fit',   // O
  'evaluar-deal',   // P
  'Reason Killed',  // Q
  'Vault Note',     // R
  'Initial Contact',// S
  'Reply',          // T
  'NDA',            // U
  'IOI/LOI Date',   // V
  'Last Activity',  // W
  'Next Action',    // X
  'Next Action Date',// Y
  'Discord Updated',// Z
  'Notes',          // AA
] as const;
const DEALFLOW_LAST_COL = 'AA';

const SCRAPER_STATE_HEADERS = [
  '#',                  // A — FK a Dealflow col A
  'source',             // B — flippa / bizscout
  'source_listing_id',  // C — id crudo del source (p.ej. "12193574")
  'url_slug',           // D — slug derivado para dedup
  'first_seen_at',      // E
  'last_seen_at',       // F
  'needs_nda_review',   // G
  'nda_verdict',        // H — GREEN/YELLOW/RED/""
  'nda_analysis',       // I
  'nda_review_date',    // J
  'nda_signed',         // K
  'nda_signed_at',      // L
  'nda_pushback_email', // M
  'raw_json',           // N
] as const;
const SCRAPER_STATE_LAST_COL = 'N';

const RUN_LOG_HEADERS = [
  'timestamp', 'source', 'duration_seconds',
  'listings_total', 'listings_new', 'listings_updated',
  'status', 'error_message',
] as const;

// ========================== Helpers ==========================

let _sheets: sheets_v4.Sheets | null = null;

function getSheetsClient(): sheets_v4.Sheets {
  if (_sheets) return _sheets;
  const credentials = JSON.parse(CONFIG.sheets.serviceAccountJson);
  const auth = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  _sheets = google.sheets({ version: 'v4', auth });
  return _sheets;
}

async function getSheetIdByName(tabName: string): Promise<number | null> {
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: CONFIG.sheets.spreadsheetId });
  const found = meta.data.sheets?.find((s) => s.properties?.title === tabName);
  return found?.properties?.sheetId ?? null;
}

async function tabExists(tabName: string): Promise<boolean> {
  return (await getSheetIdByName(tabName)) !== null;
}

async function ensureTab(tabName: string, headers: readonly string[]): Promise<void> {
  if (await tabExists(tabName)) return;
  const sheets = getSheetsClient();
  log.info(`Creando tab "${tabName}"`);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: CONFIG.sheets.spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: CONFIG.sheets.spreadsheetId,
    range: `${tabName}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [headers as string[]] },
  });
  const sheetId = await getSheetIdByName(tabName);
  if (sheetId !== null) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: CONFIG.sheets.spreadsheetId,
      requestBody: {
        requests: [{
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat.bold',
          },
        }],
      },
    });
  }
}

// ========================== Dedup ==========================

/**
 * Extrae el "slug" de una URL de listing para dedup determinístico.
 * Ej: https://flippa.com/12193574-fully-automated-saas → "12193574-fully-automated-saas"
 *     https://www.bizscout.com/businesses-for-sale/foo-bar/12345 → "foo-bar"
 */
export function extractUrlSlug(url: string): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    return (parts[parts.length - 1] || '').toLowerCase();
  } catch {
    return url.toLowerCase().split('/').filter(Boolean).pop() || '';
  }
}

// ========================== Reads ==========================

export interface DealflowRow {
  rowIndex: number; // 1-indexed; row 1 is header, data starts at 2
  num: number; // col A "#"
  dealName: string;
  sourceType: string;
  subSource: string;
  brokerContact: string;
  url: string;
  geography: string;
  established: string;
  revenue: string;
  sde: string;
  askingPrice: string;
  askingRevenue: string;
  askingSde: string;
  status: string;
  dealboxFit: string;
  evaluarDeal: string;
  reasonKilled: string;
  vaultNote: string;
  initialContact: string;
  reply: string;
  nda: string;
  ioiLoiDate: string;
  lastActivity: string;
  nextAction: string;
  nextActionDate: string;
  discordUpdated: string;
  notes: string;
}

async function readDealflow(): Promise<DealflowRow[]> {
  const sheets = getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.sheets.spreadsheetId,
    range: `${CONFIG.sheets.tabDealflow}!A2:${DEALFLOW_LAST_COL}`,
  });
  const rows = resp.data.values || [];
  return rows.map((r, i) => ({
    rowIndex: i + 2,
    num: Number(r[0]) || 0,
    dealName: String(r[1] || ''),
    sourceType: String(r[2] || ''),
    subSource: String(r[3] || ''),
    brokerContact: String(r[4] || ''),
    url: String(r[5] || ''),
    geography: String(r[6] || ''),
    established: String(r[7] || ''),
    revenue: String(r[8] || ''),
    sde: String(r[9] || ''),
    askingPrice: String(r[10] || ''),
    askingRevenue: String(r[11] || ''),
    askingSde: String(r[12] || ''),
    status: String(r[13] || ''),
    dealboxFit: String(r[14] || ''),
    evaluarDeal: String(r[15] || ''),
    reasonKilled: String(r[16] || ''),
    vaultNote: String(r[17] || ''),
    initialContact: String(r[18] || ''),
    reply: String(r[19] || ''),
    nda: String(r[20] || ''),
    ioiLoiDate: String(r[21] || ''),
    lastActivity: String(r[22] || ''),
    nextAction: String(r[23] || ''),
    nextActionDate: String(r[24] || ''),
    discordUpdated: String(r[25] || ''),
    notes: String(r[26] || ''),
  }));
}

export interface ScraperStateRow {
  rowIndex: number;
  num: number;
  source: Source | '';
  sourceListingId: string;
  urlSlug: string;
  firstSeenAt: string;
  lastSeenAt: string;
  needsNdaReview: boolean;
  ndaVerdict: NdaVerdict;
  ndaAnalysis: string;
  ndaReviewDate: string;
  ndaSigned: boolean;
  ndaSignedAt: string;
  ndaPushbackEmail: string;
  rawJson: string;
}

async function readScraperState(): Promise<ScraperStateRow[]> {
  const sheets = getSheetsClient();
  await ensureTab(CONFIG.sheets.tabScraperState, SCRAPER_STATE_HEADERS);
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.sheets.spreadsheetId,
    range: `${CONFIG.sheets.tabScraperState}!A2:${SCRAPER_STATE_LAST_COL}`,
  });
  const rows = resp.data.values || [];
  return rows.map((r, i) => ({
    rowIndex: i + 2,
    num: Number(r[0]) || 0,
    source: (String(r[1] || '') as Source | ''),
    sourceListingId: String(r[2] || ''),
    urlSlug: String(r[3] || ''),
    firstSeenAt: String(r[4] || ''),
    lastSeenAt: String(r[5] || ''),
    needsNdaReview: String(r[6]).toUpperCase() === 'TRUE',
    ndaVerdict: (String(r[7] || '') as NdaVerdict),
    ndaAnalysis: String(r[8] || ''),
    ndaReviewDate: String(r[9] || ''),
    ndaSigned: String(r[10]).toUpperCase() === 'TRUE',
    ndaSignedAt: String(r[11] || ''),
    ndaPushbackEmail: String(r[12] || ''),
    rawJson: String(r[13] || ''),
  }));
}

// ========================== Mapping ==========================

/**
 * Mapeo source → Source_Type canónico (per tab "Source types" en la SSOT).
 * - S2: Broker      → business brokers tradicionales con listings en su web
 * - S3: Market Place → plataformas tipo Flippa/BizScout/Acquire
 */
const SOURCE_TYPE_BY_SOURCE: Record<Source, string> = {
  flippa: 'S3: Market Place',
  bizscout: 'S3: Market Place',
  indianaequitybrokers: 'S2: Broker',
  synergybb: 'S2: Broker',
};

const SUB_SOURCE_BY_SOURCE: Record<Source, string> = {
  flippa: 'Flippa',
  bizscout: 'BizScout',
  indianaequitybrokers: 'Indiana Equity Brokers',
  synergybb: 'Synergy Business Brokers',
};

function sourceTypeFor(source: Source): string {
  return SOURCE_TYPE_BY_SOURCE[source] || 'S2: Broker';
}

function subSourceFor(source: Source): string {
  return SUB_SOURCE_BY_SOURCE[source] || source;
}

function defaultBrokerContact(source: Source, brokerName: string): string {
  if (brokerName) return brokerName;
  return `(contact TBD — ${subSourceFor(source)})`;
}

function establishedYearFrom(ageYears: number | null): string {
  if (ageYears == null || ageYears < 0) return '';
  return String(new Date().getFullYear() - ageYears);
}

function annual(monthly: number | null): number | null {
  return monthly != null ? Math.round(monthly * 12) : null;
}

function ndaStatusText(state: ScraperStateRow | null): string {
  if (!state) return 'Pending Review';
  if (state.ndaSigned) return `Signed ${state.ndaSignedAt?.slice(0, 10) || ''}`.trim();
  if (state.ndaVerdict === 'GREEN') return 'Reviewed: GREEN — sign pending';
  if (state.ndaVerdict === 'YELLOW') return 'Reviewed: YELLOW — pushback drafted';
  if (state.ndaVerdict === 'RED') return 'Reviewed: RED — pushback drafted';
  if (state.ndaVerdict === '') return state.needsNdaReview ? 'Pending Review' : 'No NDA';
  return '';
}

/** Construye una fila Dealflow desde un listing scrapeado + estado opcional. */
function listingToDealflowRow(
  num: number,
  listing: NormalizedListing,
  state: ScraperStateRow | null,
  isNew: boolean
): any[] {
  const todayDate = new Date().toISOString().slice(0, 10);
  return [
    num,                                                       // A
    `${listing.title} (${subSourceFor(listing.source)})`,      // B
    sourceTypeFor(listing.source),                             // C
    subSourceFor(listing.source),                              // D
    defaultBrokerContact(listing.source, listing.broker_name), // E
    listing.url,                                               // F
    listing.location || '',                                    // G
    establishedYearFrom(listing.age_years),                    // H
    annual(listing.monthly_revenue) ?? '',                     // I
    annual(listing.monthly_profit) ?? '',                      // J
    listing.asking_price ?? '',                                // K
    // L: Asking/Revenue
    listing.asking_price && listing.monthly_revenue
      ? round1(listing.asking_price / (listing.monthly_revenue * 12))
      : '',
    // M: Asking/SDE
    listing.multiple_years ?? '',                              // M
    isNew ? 'Screening' : '',                                  // N (en update no tocamos)
    '',                                                        // O Deal-box Fit (skill)
    '',                                                        // P evaluar-deal (skill)
    '',                                                        // Q Reason Killed (humano)
    '',                                                        // R Vault Note (humano)
    '',                                                        // S Initial Contact (humano)
    '',                                                        // T Reply (humano)
    ndaStatusText(state),                                      // U NDA
    '',                                                        // V IOI/LOI Date (humano)
    isNew ? todayDate : '',                                    // W Last Activity (solo en INSERT)
    isNew ? 'Auto-NDA review' : '',                            // X Next Action
    isNew ? todayDate : '',                                    // Y Next Action Date
    '',                                                        // Z Discord Updated
    '',                                                        // AA Notes (humano)
  ];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Para UPDATE: solo refresca cols que vienen del scraping. Preserva las que
 * pueden haber sido editadas por humanos (Q, R, S, T, V, W, X, Y, Z, AA, N, O, P).
 *
 * Cols a refrescar en update: B, I, J, K, L, M, U (NDA si cambió de estado)
 */
function buildDealflowUpdates(
  rowIndex: number,
  listing: NormalizedListing,
  state: ScraperStateRow | null
): { range: string; values: any[][] }[] {
  const askingRev = listing.asking_price && listing.monthly_revenue
    ? round1(listing.asking_price / (listing.monthly_revenue * 12))
    : '';
  const range = `${CONFIG.sheets.tabDealflow}!B${rowIndex}:M${rowIndex}`;
  return [
    {
      range,
      values: [[
        `${listing.title} (${subSourceFor(listing.source)})`, // B
        sourceTypeFor(listing.source),                        // C
        subSourceFor(listing.source),                         // D
        defaultBrokerContact(listing.source, listing.broker_name), // E
        listing.url,                                          // F
        listing.location || '',                               // G
        establishedYearFrom(listing.age_years),               // H
        annual(listing.monthly_revenue) ?? '',                // I
        annual(listing.monthly_profit) ?? '',                 // J
        listing.asking_price ?? '',                           // K
        askingRev,                                            // L
        listing.multiple_years ?? '',                         // M
      ]],
    },
    {
      // U separadamente porque está fuera del bloque B:M
      range: `${CONFIG.sheets.tabDealflow}!U${rowIndex}`,
      values: [[ndaStatusText(state)]],
    },
  ];
}

// ========================== Upsert ==========================

export interface UpsertResult {
  inserted: number;
  updated: number;
  total: number;
}

export async function upsertListings(listings: NormalizedListing[]): Promise<UpsertResult> {
  await ensureTab(CONFIG.sheets.tabScraperState, SCRAPER_STATE_HEADERS);

  const sheets = getSheetsClient();
  const [dealflow, scraperState] = await Promise.all([readDealflow(), readScraperState()]);

  // Índices para dedup
  const stateBySlug = new Map<string, ScraperStateRow>();
  const stateByListingId = new Map<string, ScraperStateRow>(); // key: `${source}|${id}`
  for (const s of scraperState) {
    if (s.urlSlug) stateBySlug.set(s.urlSlug, s);
    if (s.source && s.sourceListingId) {
      stateByListingId.set(`${s.source}|${s.sourceListingId}`, s);
    }
  }
  const dealflowByNum = new Map<number, DealflowRow>();
  for (const d of dealflow) {
    if (d.num) dealflowByNum.set(d.num, d);
  }

  let maxNum = 0;
  for (const d of dealflow) if (d.num > maxNum) maxNum = d.num;

  const now = new Date().toISOString();
  const todayDate = now.slice(0, 10);

  const toInsertDealflow: any[][] = [];
  const toInsertState: any[][] = [];
  const dealflowUpdates: { range: string; values: any[][] }[] = [];
  const stateUpdates: { range: string; values: any[][] }[] = [];

  let inserted = 0;
  let updated = 0;

  for (const listing of listings) {
    const slug = extractUrlSlug(listing.url);
    const idKey = `${listing.source}|${listing.listing_id}`;
    const existingState = stateBySlug.get(slug) || stateByListingId.get(idKey) || null;

    if (existingState) {
      // UPDATE
      const dealflowRow = dealflowByNum.get(existingState.num);
      if (dealflowRow) {
        dealflowUpdates.push(...buildDealflowUpdates(dealflowRow.rowIndex, listing, existingState));
      }
      // Refresca Scraper_State: last_seen, raw_json
      stateUpdates.push({
        range: `${CONFIG.sheets.tabScraperState}!F${existingState.rowIndex}`,
        values: [[now]],
      });
      stateUpdates.push({
        range: `${CONFIG.sheets.tabScraperState}!N${existingState.rowIndex}`,
        values: [[listing.raw_json]],
      });
      updated++;
    } else {
      // INSERT
      maxNum++;
      const num = maxNum;
      toInsertDealflow.push(listingToDealflowRow(num, listing, null, true));
      toInsertState.push([
        num,
        listing.source,
        listing.listing_id,
        slug,
        now,                // first_seen_at
        now,                // last_seen_at
        'TRUE',             // needs_nda_review
        '',                 // nda_verdict
        '',                 // nda_analysis
        '',                 // nda_review_date
        'FALSE',            // nda_signed
        '',                 // nda_signed_at
        '',                 // nda_pushback_email
        listing.raw_json,
      ]);
      inserted++;
    }
  }

  // Bulk inserts
  if (toInsertDealflow.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.sheets.spreadsheetId,
      range: `${CONFIG.sheets.tabDealflow}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: toInsertDealflow },
    });
  }
  if (toInsertState.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.sheets.spreadsheetId,
      range: `${CONFIG.sheets.tabScraperState}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: toInsertState },
    });
  }
  // Bulk updates
  if (dealflowUpdates.length > 0 || stateUpdates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: CONFIG.sheets.spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: [...dealflowUpdates, ...stateUpdates],
      },
    });
  }

  return { inserted, updated, total: listings.length };
}

// ========================== NDA flow accessors ==========================

export interface PendingNdaItem {
  scraperStateRowIndex: number;
  dealflowRowIndex: number | null;
  num: number;
  source: Source;
  listingId: string;
  url: string;
  title: string;
  ndaSigned: boolean;
  ndaVerdict: NdaVerdict;
  ndaAnalysis: string;
  ndaReviewDate: string;
  ndaSignedAt: string;
}

export async function getListingsPendingNdaReview(): Promise<PendingNdaItem[]> {
  const [dealflow, state] = await Promise.all([readDealflow(), readScraperState()]);
  const dealByNum = new Map<number, DealflowRow>();
  for (const d of dealflow) if (d.num) dealByNum.set(d.num, d);

  return state
    .filter((s) => s.needsNdaReview && !s.ndaVerdict)
    .map((s) => mapPending(s, dealByNum.get(s.num) || null))
    .filter((x): x is PendingNdaItem => x !== null);
}

export async function getListingsPendingNdaSign(): Promise<PendingNdaItem[]> {
  const [dealflow, state] = await Promise.all([readDealflow(), readScraperState()]);
  const dealByNum = new Map<number, DealflowRow>();
  for (const d of dealflow) if (d.num) dealByNum.set(d.num, d);

  return state
    .filter((s) => s.ndaVerdict === 'GREEN' && !s.ndaSigned)
    .map((s) => mapPending(s, dealByNum.get(s.num) || null))
    .filter((x): x is PendingNdaItem => x !== null);
}

function mapPending(s: ScraperStateRow, d: DealflowRow | null): PendingNdaItem | null {
  if (!s.source) return null;
  return {
    scraperStateRowIndex: s.rowIndex,
    dealflowRowIndex: d?.rowIndex ?? null,
    num: s.num,
    source: s.source,
    listingId: s.sourceListingId,
    url: d?.url || '',
    title: d?.dealName || '',
    ndaSigned: s.ndaSigned,
    ndaVerdict: s.ndaVerdict,
    ndaAnalysis: s.ndaAnalysis,
    ndaReviewDate: s.ndaReviewDate,
    ndaSignedAt: s.ndaSignedAt,
  };
}

export interface NdaFieldsUpdate {
  needs_nda_review: boolean;
  nda_verdict: NdaVerdict;
  nda_analysis: string;
  nda_review_date: string;
  nda_signed: boolean;
  nda_signed_at: string;
  nda_pushback_email: string;
}

/** Actualiza Scraper_State cols G:M + Dealflow col U (NDA status) en una fila. */
export async function updateNdaFields(
  scraperStateRowIndex: number,
  dealflowRowIndex: number | null,
  updates: NdaFieldsUpdate
): Promise<void> {
  const sheets = getSheetsClient();
  const stateValues = [[
    updates.needs_nda_review ? 'TRUE' : 'FALSE',
    updates.nda_verdict || '',
    updates.nda_analysis || '',
    updates.nda_review_date || '',
    updates.nda_signed ? 'TRUE' : 'FALSE',
    updates.nda_signed_at || '',
    updates.nda_pushback_email || '',
  ]];

  const batchData: { range: string; values: any[][] }[] = [{
    range: `${CONFIG.sheets.tabScraperState}!G${scraperStateRowIndex}:M${scraperStateRowIndex}`,
    values: stateValues,
  }];

  // Sincronizar col U (NDA) en Dealflow con un text status legible para humanos
  if (dealflowRowIndex) {
    batchData.push({
      range: `${CONFIG.sheets.tabDealflow}!U${dealflowRowIndex}`,
      values: [[ndaStatusText({
        rowIndex: scraperStateRowIndex,
        num: 0, source: '', sourceListingId: '', urlSlug: '',
        firstSeenAt: '', lastSeenAt: '',
        needsNdaReview: updates.needs_nda_review,
        ndaVerdict: updates.nda_verdict,
        ndaAnalysis: updates.nda_analysis,
        ndaReviewDate: updates.nda_review_date,
        ndaSigned: updates.nda_signed,
        ndaSignedAt: updates.nda_signed_at,
        ndaPushbackEmail: updates.nda_pushback_email,
        rawJson: '',
      })]],
    });
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: CONFIG.sheets.spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data: batchData },
  });
}

// ========================== Run Log ==========================

export async function appendRunLog(entry: RunLogEntry): Promise<void> {
  await ensureTab(CONFIG.sheets.tabRunLog, RUN_LOG_HEADERS);
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: CONFIG.sheets.spreadsheetId,
    range: `${CONFIG.sheets.tabRunLog}!A1`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        entry.timestamp, entry.source, entry.duration_seconds,
        entry.listings_total, entry.listings_new, entry.listings_updated,
        entry.status, entry.error_message,
      ]],
    },
  });
}

export async function getRecentRunLog(source: Source, limit: number): Promise<RunLogEntry[]> {
  const sheets = getSheetsClient();
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.sheets.spreadsheetId,
      range: `${CONFIG.sheets.tabRunLog}!A2:H`,
    });
    const rows = resp.data.values || [];
    return rows
      .map((r) => ({
        timestamp: String(r[0] || ''),
        source: String(r[1] || '') as Source,
        duration_seconds: Number(r[2] || 0),
        listings_total: Number(r[3] || 0),
        listings_new: Number(r[4] || 0),
        listings_updated: Number(r[5] || 0),
        status: (String(r[6] || 'error') as 'success' | 'error'),
        error_message: String(r[7] || ''),
      }))
      .filter((e) => e.source === source)
      .slice(-limit);
  } catch {
    return [];
  }
}
