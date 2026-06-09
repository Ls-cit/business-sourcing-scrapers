/**
 * NDA Pipeline Processor (Task 2 + Task 3 combinados).
 *
 * Flujo:
 *   1. Lee Scraper_State → busca listings con needs_nda_review=TRUE y nda_verdict vacío.
 *   2. Loguea en Flippa (reusa loginFlippa del scraper).
 *   3. Para cada listing pendiente:
 *      a. Extrae texto del NDA del listing
 *      b. Envía a Anthropic API → obtiene verdict + analysis + pushback_email
 *      c. Si verdict === GREEN → firma automáticamente (Task 3), salvo NDA_DRY_RUN
 *      d. Si verdict === YELLOW/RED → guarda pushback draft + manda email
 *      e. Update Scraper_State (verdict/analysis/firma) + Dealflow col U (status legible)
 *   4. Devuelve summary.
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
  type PendingNdaItem,
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
  const flippaPending = pending.filter((p) => p.source === 'flippa');

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

    for (const item of flippaPending) {
      try {
        log.info(`NDA process: [#${item.num} ${item.listingId}] ${item.title.slice(0, 60)}`);

        // Extract
        const ext = await extractNdaFromListing(context, item.url);
        if (!ext.hasNda) {
          log.warn(`NDA process: [#${item.num}] no tiene NDA visible — skip`);
          await updateNdaFields(item.scraperStateRowIndex, item.dealflowRowIndex, {
            needs_nda_review: false,
            nda_verdict: '',
            nda_analysis: 'No NDA visible en la página (requiere acceso especial o el listing cambió)',
            nda_review_date: new Date().toISOString(),
            nda_signed: item.ndaSigned,
            nda_signed_at: item.ndaSignedAt,
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
        ].join('\n').slice(0, 5000);

        const baseUpdate: NdaFieldsUpdate = {
          needs_nda_review: false,
          nda_verdict: review.verdict,
          nda_analysis: analysisSummary,
          nda_review_date: reviewDate,
          nda_signed: item.ndaSigned,
          nda_signed_at: item.ndaSignedAt,
          nda_pushback_email: review.pushback_email,
        };

        if (review.verdict === 'GREEN') {
          if (CONFIG.nda.dryRun) {
            log.warn(`NDA process: [#${item.num}] verdict GREEN — DRY_RUN, no firmo`);
            await updateNdaFields(item.scraperStateRowIndex, item.dealflowRowIndex, baseUpdate);
          } else {
            log.info(`NDA process: [#${item.num}] verdict GREEN → firmando`);
            await humanDelay(2000, 4000);
            const sign = await signNdaOnFlippa(context, item.url);
            if (sign.signed) {
              result.signed++;
              await updateNdaFields(item.scraperStateRowIndex, item.dealflowRowIndex, {
                ...baseUpdate,
                nda_signed: true,
                nda_signed_at: new Date().toISOString(),
              });
            } else {
              log.warn(`NDA process: [#${item.num}] firma falló: ${sign.error}`);
              await updateNdaFields(item.scraperStateRowIndex, item.dealflowRowIndex, {
                ...baseUpdate,
                nda_signed: false,
                nda_signed_at: '',
                nda_pushback_email: `[AUTO-SIGN FAILED] ${sign.error || ''}`,
              });
            }
          }
        } else {
          log.info(`NDA process: [#${item.num}] verdict ${review.verdict} → pushback`);
          await updateNdaFields(item.scraperStateRowIndex, item.dealflowRowIndex, baseUpdate);
          if (review.pushback_email) {
            await sendPushbackEmail({
              listingId: item.listingId,
              listingTitle: item.title,
              listingUrl: item.url,
              verdict: review.verdict,
              rationale: review.rationale,
              pushbackBody: review.pushback_email,
            });
            result.pushback_drafted++;
          }
        }

        await humanDelay(3000, 6000);
      } catch (err) {
        result.errors++;
        log.error(`NDA process: [#${item.num}] error`, err);
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
 * Firma todos los listings con verdict=GREEN y nda_signed=FALSE.
 * Usar después de un NDA_DRY_RUN para concretar las firmas.
 */
export async function processSignPendingGreens(): Promise<NdaSignGreensResult> {
  const pending = await getListingsPendingNdaSign();
  const flippaPending = pending.filter((p) => p.source === 'flippa');

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

    for (const item of flippaPending) {
      try {
        log.info(`sign-greens: [#${item.num} ${item.listingId}] firmando`);
        await humanDelay(2000, 4000);
        const sign = await signNdaOnFlippa(context, item.url);
        if (sign.signed) {
          result.signed++;
          await updateNdaFields(item.scraperStateRowIndex, item.dealflowRowIndex, {
            needs_nda_review: false,
            nda_verdict: 'GREEN',
            nda_analysis: item.ndaAnalysis,
            nda_review_date: item.ndaReviewDate,
            nda_signed: true,
            nda_signed_at: new Date().toISOString(),
            nda_pushback_email: '',
          });
        } else {
          log.warn(`sign-greens: [#${item.num}] firma falló: ${sign.error}`);
          result.errors++;
        }
        await humanDelay(3000, 6000);
      } catch (err) {
        result.errors++;
        log.error(`sign-greens: [#${item.num}] error`, err);
      }
    }
  } finally {
    if (browser) await browser.close();
  }

  log.info(`sign-greens: done — ${JSON.stringify(result)}`);
  return result;
}

// Suppress unused type warning
export type { PendingNdaItem };
