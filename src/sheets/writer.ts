/**
 * Google Sheets writer con dedup.
 *
 * Estrategia:
 *   - Lee el tab Scraper_Inflow completo en memoria.
 *   - Indexa por clave (source, listing_id).
 *   - Para cada listing scrapeado: si existe → update last_seen_at; si no → insert.
 *   - Single write al final (batchUpdate) para minimizar requests a la Sheets API.
 *
 * También maneja Run_Log: agrega una fila por cada corrida de cada source.
 */

import { google, sheets_v4 } from 'googleapis';
import { JWT } from 'google-auth-library';
import { CONFIG } from '../config.js';
import { log } from '../utils/log.js';
import type { NormalizedListing, ListingRow, RunLogEntry, Source } from '../types.js';

const INFLOW_HEADERS = [
  'source',            // A
  'listing_id',        // B
  'title',             // C
  'asking_price',      // D
  'monthly_profit',    // E
  'monthly_revenue',   // F
  'multiple_years',    // G
  'location',          // H
  'category',          // I
  'age_years',         // J
  'status',            // K
  'url',               // L
  'broker_name',       // M
  'broker_email',      // N
  'broker_phone',      // O
  'first_seen_at',     // P
  'last_seen_at',      // Q
  'needs_nda_review',  // R
  'nda_verdict',       // S
  'nda_analysis',      // T
  'nda_review_date',   // U
  'nda_signed',        // V
  'nda_signed_at',     // W
  'nda_pushback_email',// X
  'raw_json',          // Y
] as const;

const INFLOW_LAST_COL = 'Y'; // 25 columnas

const RUN_LOG_HEADERS = [
  'timestamp',
  'source',
  'duration_seconds',
  'listings_total',
  'listings_new',
  'listings_updated',
  'status',
  'error_message',
] as const;

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

/** Garantiza que un tab exista. Si no existe, lo crea con los headers dados. */
async function ensureTab(tabName: string, headers: readonly string[]): Promise<void> {
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: CONFIG.sheets.spreadsheetId });
  const existing = meta.data.sheets?.find((s) => s.properties?.title === tabName);

  if (!existing) {
    log.info(`Creando tab "${tabName}"`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: CONFIG.sheets.spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
    // Insert headers
    await sheets.spreadsheets.values.update({
      spreadsheetId: CONFIG.sheets.spreadsheetId,
      range: `${tabName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers as string[]] },
    });
    // Bold header row
    const sheetId = await getSheetIdByName(tabName);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: CONFIG.sheets.spreadsheetId,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: { userEnteredFormat: { textFormat: { bold: true } } },
              fields: 'userEnteredFormat.textFormat.bold',
            },
          },
        ],
      },
    });
  }
}

async function getSheetIdByName(tabName: string): Promise<number> {
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: CONFIG.sheets.spreadsheetId });
  const found = meta.data.sheets?.find((s) => s.properties?.title === tabName);
  if (!found?.properties?.sheetId && found?.properties?.sheetId !== 0) {
    throw new Error(`Tab "${tabName}" not found`);
  }
  return found.properties.sheetId;
}

/** Lee TODO el tab Scraper_Inflow e indexa por (source, listing_id). */
export async function readInflow(): Promise<Map<string, { rowIndex: number; row: ListingRow }>> {
  const sheets = getSheetsClient();
  const range = `${CONFIG.sheets.tabInflow}!A2:${INFLOW_LAST_COL}`;
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.sheets.spreadsheetId,
    range,
  });
  const rows = resp.data.values || [];
  const map = new Map<string, { rowIndex: number; row: ListingRow }>();
  rows.forEach((r, i) => {
    const row = rowArrayToObject(r);
    if (row.source && row.listing_id) {
      const key = `${row.source}|${row.listing_id}`;
      map.set(key, { rowIndex: i + 2, row });
    }
  });
  return map;
}

function rowArrayToObject(r: any[]): ListingRow {
  const get = (i: number) => r[i] ?? '';
  return {
    source: get(0) as Source,
    listing_id: String(get(1)),
    title: String(get(2)),
    asking_price: get(3) === '' ? null : Number(get(3)),
    monthly_profit: get(4) === '' ? null : Number(get(4)),
    monthly_revenue: get(5) === '' ? null : Number(get(5)),
    multiple_years: get(6) === '' ? null : Number(get(6)),
    location: String(get(7)),
    category: String(get(8)),
    age_years: get(9) === '' ? null : Number(get(9)),
    status: String(get(10)),
    url: String(get(11)),
    broker_name: String(get(12)),
    broker_email: String(get(13)),
    broker_phone: String(get(14)),
    first_seen_at: String(get(15)),
    last_seen_at: String(get(16)),
    needs_nda_review: String(get(17)).toUpperCase() === 'TRUE',
    nda_verdict: (String(get(18)) as ListingRow['nda_verdict']) || '',
    nda_analysis: String(get(19)),
    nda_review_date: String(get(20)),
    nda_signed: String(get(21)).toUpperCase() === 'TRUE',
    nda_signed_at: String(get(22)),
    nda_pushback_email: String(get(23)),
    raw_json: String(get(24)),
  };
}

function rowObjectToArray(row: ListingRow): any[] {
  return [
    row.source,
    row.listing_id,
    row.title,
    row.asking_price ?? '',
    row.monthly_profit ?? '',
    row.monthly_revenue ?? '',
    row.multiple_years ?? '',
    row.location,
    row.category,
    row.age_years ?? '',
    row.status,
    row.url,
    row.broker_name,
    row.broker_email,
    row.broker_phone,
    row.first_seen_at,
    row.last_seen_at,
    row.needs_nda_review ? 'TRUE' : 'FALSE',
    row.nda_verdict || '',
    row.nda_analysis || '',
    row.nda_review_date || '',
    row.nda_signed ? 'TRUE' : 'FALSE',
    row.nda_signed_at || '',
    row.nda_pushback_email || '',
    row.raw_json,
  ];
}

export interface UpsertResult {
  inserted: number;
  updated: number;
  total: number;
}

/**
 * Upserts una lista de listings en Scraper_Inflow.
 * - Nuevo listing → INSERT con first_seen_at = now, needs_nda_review = true
 * - Existente → UPDATE solo last_seen_at + status + asking_price + raw_json (datos que pueden cambiar)
 *               needs_nda_review se preserva (no se re-trigger Task 2)
 */
export async function upsertListings(listings: NormalizedListing[]): Promise<UpsertResult> {
  await ensureTab(CONFIG.sheets.tabInflow, INFLOW_HEADERS);

  const existing = await readInflow();
  const now = new Date().toISOString();
  const sheets = getSheetsClient();

  const toInsert: ListingRow[] = [];
  const updates: { range: string; values: any[][] }[] = [];

  for (const listing of listings) {
    const key = `${listing.source}|${listing.listing_id}`;
    const found = existing.get(key);

    if (!found) {
      // INSERT
      toInsert.push({
        ...listing,
        first_seen_at: now,
        last_seen_at: now,
        needs_nda_review: true,
        nda_verdict: '',
        nda_analysis: '',
        nda_review_date: '',
        nda_signed: false,
        nda_signed_at: '',
        nda_pushback_email: '',
      });
    } else {
      // UPDATE — preserva todo lo de NDA flow + first_seen_at; refresca data scrapeada.
      const updated: ListingRow = {
        ...found.row,
        first_seen_at: found.row.first_seen_at,
        needs_nda_review: found.row.needs_nda_review,
        nda_verdict: found.row.nda_verdict,
        nda_analysis: found.row.nda_analysis,
        nda_review_date: found.row.nda_review_date,
        nda_signed: found.row.nda_signed,
        nda_signed_at: found.row.nda_signed_at,
        nda_pushback_email: found.row.nda_pushback_email,
        // Refrescar datos que pueden haber cambiado
        title: listing.title,
        asking_price: listing.asking_price,
        monthly_profit: listing.monthly_profit,
        monthly_revenue: listing.monthly_revenue,
        multiple_years: listing.multiple_years,
        location: listing.location,
        category: listing.category,
        age_years: listing.age_years,
        status: listing.status,
        url: listing.url,
        broker_name: listing.broker_name || found.row.broker_name,
        broker_email: listing.broker_email || found.row.broker_email,
        broker_phone: listing.broker_phone || found.row.broker_phone,
        raw_json: listing.raw_json,
        last_seen_at: now,
      };
      updates.push({
        range: `${CONFIG.sheets.tabInflow}!A${found.rowIndex}:${INFLOW_LAST_COL}${found.rowIndex}`,
        values: [rowObjectToArray(updated)],
      });
    }
  }

  // INSERTs (append en bulk)
  if (toInsert.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.sheets.spreadsheetId,
      range: `${CONFIG.sheets.tabInflow}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: toInsert.map(rowObjectToArray) },
    });
  }

  // UPDATEs (batch)
  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: CONFIG.sheets.spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: updates,
      },
    });
  }

  return {
    inserted: toInsert.length,
    updated: updates.length,
    total: listings.length,
  };
}

/**
 * Devuelve filas que necesitan NDA review (needs_nda_review=TRUE y nda_verdict vacío).
 */
export async function getListingsPendingNdaReview(): Promise<Array<{ rowIndex: number; row: ListingRow }>> {
  const all = await readInflow();
  const pending: Array<{ rowIndex: number; row: ListingRow }> = [];
  for (const entry of all.values()) {
    if (entry.row.needs_nda_review && !entry.row.nda_verdict) {
      pending.push(entry);
    }
  }
  return pending;
}

/**
 * Devuelve filas con verdict=GREEN que aún NO firmamos.
 * Útil para el comando `sign-greens` (después de un dry-run).
 */
export async function getListingsPendingNdaSign(): Promise<Array<{ rowIndex: number; row: ListingRow }>> {
  const all = await readInflow();
  const pending: Array<{ rowIndex: number; row: ListingRow }> = [];
  for (const entry of all.values()) {
    if (entry.row.nda_verdict === 'GREEN' && !entry.row.nda_signed) {
      pending.push(entry);
    }
  }
  return pending;
}

/**
 * Actualiza solo los campos NDA de una fila específica (no toca el resto).
 */
export interface NdaFieldsUpdate {
  nda_verdict: ListingRow['nda_verdict'];
  nda_analysis: string;
  nda_review_date: string;
  nda_signed: boolean;
  nda_signed_at: string;
  nda_pushback_email: string;
  /** Cuando review + sign están completos, lo bajamos a FALSE para no re-procesar */
  needs_nda_review: boolean;
}

export async function updateNdaFields(
  rowIndex: number,
  updates: NdaFieldsUpdate
): Promise<void> {
  const sheets = getSheetsClient();
  // Cols R..X (needs_nda_review hasta nda_pushback_email)
  const values = [[
    updates.needs_nda_review ? 'TRUE' : 'FALSE',
    updates.nda_verdict || '',
    updates.nda_analysis || '',
    updates.nda_review_date || '',
    updates.nda_signed ? 'TRUE' : 'FALSE',
    updates.nda_signed_at || '',
    updates.nda_pushback_email || '',
  ]];
  await sheets.spreadsheets.values.update({
    spreadsheetId: CONFIG.sheets.spreadsheetId,
    range: `${CONFIG.sheets.tabInflow}!R${rowIndex}:X${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}

/** Agrega una fila al Run_Log. */
export async function appendRunLog(entry: RunLogEntry): Promise<void> {
  await ensureTab(CONFIG.sheets.tabRunLog, RUN_LOG_HEADERS);
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: CONFIG.sheets.spreadsheetId,
    range: `${CONFIG.sheets.tabRunLog}!A1`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [
        [
          entry.timestamp,
          entry.source,
          entry.duration_seconds,
          entry.listings_total,
          entry.listings_new,
          entry.listings_updated,
          entry.status,
          entry.error_message,
        ],
      ],
    },
  });
}

/** Lee las últimas N entradas de Run_Log para una source. Útil para detectar fallos consecutivos. */
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
