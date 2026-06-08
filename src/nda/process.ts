/**
 * NDA Pipeline Processor (Task 2 + Task 3 combinados).
 *
 * Flujo:
 *   1. Lee Sheet → busca listings con needs_nda_review=TRUE y nda_verdict vacío.
 *   2. Loguea en Flippa (reusa loginFlippa del scraper).
 *   3. Para cada listing pendiente:
 *      a. Extrae texto del NDA del listing
 *      b. Envía a Anthropic API → obtiene verdict + analysis + pushback_email
 *      c. Si verdict === GREEN → firma automáticamente (Task 3)
 *      d. Si verdict === YELLOW/RED → guarda pushback draft + manda email
 *      e. Update sheet con resultado (per-listing, atómico)
 *   4. Devuelve summary (reviewed, signed, pushback_drafted, errors).
 *
 * Notas operativas:
 *   - Si el browser muere a mitad → el progreso queda en la Sheet por listing
 *     (no perdés trabajo).
 *   - Delays humanos entre listings para no levantar alarmas.
 */

import { chromium, Browser } from 'playwright';
import { CONFIG } from '../config.js';
import { log, humanDelay } from '../utils/log.js';
import { loginFlippa } from '../scrapers/flippa.js';
import { extractNdaFromListing } from './extract.js';
import { reviewNda } from './review.js';
import { signNdaOnFlippa } from './sign.js';
import {
  getListingsPendingNdaReview,
  getListingsPendingNdaSign,
  updateNdaFields,
  type NdaFieldsUpdate,
} from '../sheets/writer.js';
import { sendPushbackEmail } from '../notify/pushback.js';

export interface NdaProcessResult {
  considered: number;
  reviewed: number;
  signed: number;
  pushback_drafted: number;
  errors: number;
}

export async function processNdaQueue(): Promise<NdaProcessResult> {
  const pending = await getListingsPendingNdaReview();
  const flippaPending = pending.filter((p) => p.row.source === 'flippa');

  log.info(`NDA process: ${flippaPending.length} listings pending review (Flippa)`);

  const result: NdaProcessResult = {
    considered: flippaPending.length,
    reviewed: 0,
    signed: 0,
    pushback_drafted: 0,
    errors: 0,
  };

  if (flippaPending.length === 0) return result;
  if (!CONFIG.flippa.email || !CONFIG.flippa.password) {
    log.warn('NDA process: Flippa credentials no seteadas — skip');
    return result;
  }

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
    });

    await loginFlippa(context);

    for (const { rowIndex, row } of flippaPending) {
      try {
        log.info(`NDA process: [${row.listing_id}] ${row.title.slice(0, 60)}`);

        // Extract
        const ext = await extractNdaFromListing(context, row.url);
        if (!ext.hasNda) {
          log.warn(`NDA process: [${row.listing_id}] no tiene NDA visible — skip`);
          await updateNdaFields(rowIndex, {
            needs_nda_review: false,
            nda_verdict: '',
            nda_analysis: 'No NDA visible en la página (requiere acceso especial o el listing cambió)',
            nda_review_date: new Date().toISOString(),
            nda_signed: row.nda_signed,
            nda_signed_at: row.nda_signed_at,
            nda_pushback_email: '',
          });
          continue;
        }

        // Review
        const review = await reviewNda(ext.ndaText);
        result.reviewed++;
        const reviewDate = new Date().toISOString();

        const analysisSummary = [
          review.rationale,
          '',
          'Cláusulas notables:',
          ...review.clauses_notable.map((c) => `- [${c.classification}] ${c.clause}: ${c.note}`),
        ].join('\n').slice(0, 5000); // tope para Sheet cell

        const baseUpdate: NdaFieldsUpdate = {
          needs_nda_review: false,
          nda_verdict: review.verdict,
          nda_analysis: analysisSummary,
          nda_review_date: reviewDate,
          nda_signed: row.nda_signed,
          nda_signed_at: row.nda_signed_at,
          nda_pushback_email: review.pushback_email,
        };

        if (review.verdict === 'GREEN') {
          if (CONFIG.nda.dryRun) {
            log.warn(`NDA process: [${row.listing_id}] verdict GREEN — DRY_RUN, no firmo`);
            await updateNdaFields(rowIndex, baseUpdate);
            // nda_signed queda en false, verdict GREEN guardado, listing queda elegible para `sign-greens`
          } else {
            // Sign
            log.info(`NDA process: [${row.listing_id}] verdict GREEN → firmando`);
            await humanDelay(2000, 4000);
            const sign = await signNdaOnFlippa(context, row.url);
            if (sign.signed) {
              result.signed++;
              await updateNdaFields(rowIndex, {
                ...baseUpdate,
                nda_signed: true,
                nda_signed_at: new Date().toISOString(),
              });
            } else {
              log.warn(`NDA process: [${row.listing_id}] firma falló: ${sign.error}`);
              await updateNdaFields(rowIndex, {
                ...baseUpdate,
                nda_signed: false,
                nda_signed_at: '',
                nda_pushback_email: `[AUTO-SIGN FAILED] ${sign.error || ''}`,
              });
            }
          }
        } else {
          // YELLOW / RED — guarda pushback + manda email
          log.info(`NDA process: [${row.listing_id}] verdict ${review.verdict} → pushback`);
          await updateNdaFields(rowIndex, baseUpdate);
          if (review.pushback_email) {
            await sendPushbackEmail({
              listingId: row.listing_id,
              listingTitle: row.title,
              listingUrl: row.url,
              verdict: review.verdict,
              rationale: review.rationale,
              pushbackBody: review.pushback_email,
            });
            result.pushback_drafted++;
          }
        }

        await humanDelay(3000, 6000); // delay entre listings
      } catch (err) {
        result.errors++;
        log.error(`NDA process: [${row.listing_id}] error`, err);
      }
    }
  } finally {
    if (browser) await browser.close();
  }

  log.info(`NDA process: done — ${JSON.stringify(result)}`);
  return result;
}

export interface NdaSignGreensResult {
  considered: number;
  signed: number;
  errors: number;
}

/**
 * Firma TODOS los listings que ya tienen verdict=GREEN y nda_signed=FALSE.
 * Pensado para usar después de un NDA_DRY_RUN: una vez que viste los verdicts,
 * disparás esto para concretar las firmas.
 */
export async function processSignPendingGreens(): Promise<NdaSignGreensResult> {
  const pending = await getListingsPendingNdaSign();
  const flippaPending = pending.filter((p) => p.row.source === 'flippa');

  log.info(`sign-greens: ${flippaPending.length} listings GREEN pending sign (Flippa)`);
  const result: NdaSignGreensResult = { considered: flippaPending.length, signed: 0, errors: 0 };

  if (flippaPending.length === 0) return result;
  if (!CONFIG.flippa.email || !CONFIG.flippa.password) {
    log.warn('sign-greens: Flippa credentials no seteadas — skip');
    return result;
  }

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
    });

    await loginFlippa(context);

    for (const { rowIndex, row } of flippaPending) {
      try {
        log.info(`sign-greens: [${row.listing_id}] firmando`);
        await humanDelay(2000, 4000);
        const sign = await signNdaOnFlippa(context, row.url);
        if (sign.signed) {
          result.signed++;
          await updateNdaFields(rowIndex, {
            needs_nda_review: false,
            nda_verdict: 'GREEN',
            nda_analysis: row.nda_analysis,
            nda_review_date: row.nda_review_date,
            nda_signed: true,
            nda_signed_at: new Date().toISOString(),
            nda_pushback_email: '',
          });
        } else {
          log.warn(`sign-greens: [${row.listing_id}] firma falló: ${sign.error}`);
          result.errors++;
        }
        await humanDelay(3000, 6000);
      } catch (err) {
        result.errors++;
        log.error(`sign-greens: [${row.listing_id}] error`, err);
      }
    }
  } finally {
    if (browser) await browser.close();
  }

  log.info(`sign-greens: done — ${JSON.stringify(result)}`);
  return result;
}
