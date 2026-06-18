/**
 * Tipos compartidos entre scrapers, sheets writer y notifier.
 */

export type Source =
  | 'flippa'
  | 'bizscout'
  | 'indianaequitybrokers'
  | 'synergybb'
  | 'inbargroup'
  | 'tworld';

/**
 * Schema unificado de un listing en el tab Scraper_Inflow.
 * Los campos que no aplican a una fuente quedan como null/empty string
 * (NO 'N/D' — para no romper filtros numéricos).
 */
export interface NormalizedListing {
  source: Source;
  listing_id: string;
  title: string;
  asking_price: number | null;
  monthly_profit: number | null;
  monthly_revenue: number | null;
  multiple_years: number | null;
  location: string;
  category: string;
  age_years: number | null;
  status: string;
  url: string;
  broker_name: string;
  broker_email: string;
  broker_phone: string;
  /** Compact JSON con el payload original — útil para auditar / agregar campos. */
  raw_json: string;
}

/**
 * Estado por listing en la Sheet (después del dedup).
 */
export type NdaVerdict = 'GREEN' | 'YELLOW' | 'RED' | '';

export interface ListingRow extends NormalizedListing {
  first_seen_at: string; // ISO timestamp
  last_seen_at: string;  // ISO timestamp
  /** true = Task 2 (NDA review) aún no procesó esta fila */
  needs_nda_review: boolean;
  /** GREEN/YELLOW/RED del análisis del NDA (vacío si todavía no se analizó) */
  nda_verdict: NdaVerdict;
  /** Resumen del análisis (cláusulas notables, racional) */
  nda_analysis: string;
  /** ISO timestamp del review */
  nda_review_date: string;
  /** true cuando Task 3 firmó el NDA */
  nda_signed: boolean;
  /** ISO timestamp de la firma */
  nda_signed_at: string;
  /** Draft del email de pushback (si verdict 🟡/🔴) — se manda a codingit5 */
  nda_pushback_email: string;
}

/** Resultado del análisis NDA (lo que devuelve Anthropic API parseado). */
export interface NdaReviewResult {
  verdict: NdaVerdict;
  rationale: string;
  clauses_notable: Array<{ clause: string; classification: string; note: string }>;
  pushback_email: string; // vacío si verdict es GREEN
}

export interface ScraperResult {
  source: Source;
  listings: NormalizedListing[];
  /** Cuántos requests HTTP hizo (para anti-ban awareness) */
  requestCount: number;
  /** ms */
  durationMs: number;
}

export interface RunLogEntry {
  timestamp: string;
  source: Source;
  duration_seconds: number;
  listings_total: number;
  listings_new: number;
  listings_updated: number;
  status: 'success' | 'error';
  error_message: string;
}
