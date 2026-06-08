/**
 * Auto-firma del NDA en Flippa (solo se invoca cuando verdict === 'GREEN').
 *
 * Flujo Flippa observado:
 *  1. Listing detail page tiene un checkbox "I accept the terms..." + botón "Sign NDA and Continue"
 *  2. Tras click se abre Step 2: form con dropdowns + textarea "Message for seller"
 *  3. Submit final → confirmación + estado "Pending approval"
 *
 * Estrategia conservadora: si CUALQUIER paso falla, abortar y NO marcar firmado.
 * Mejor un falso negativo (manual sign luego) que un falso positivo (no se firmó pero
 * la Sheet dice que sí).
 */

import type { BrowserContext, Page } from 'playwright';
import { CONFIG } from '../config.js';
import { log, humanDelay } from '../utils/log.js';

export interface NdaSignResult {
  signed: boolean;
  error?: string;
}

const ACQUISITION_TIMELINE = 'Actively buying — looking to close within 3 months';
const FUND_SOURCE = 'Corporate, Family Office or Fund Capital';

const MESSAGE_FOR_SELLER = `
Hi,

I'm reviewing SaaS acquisition opportunities in the $750K–$1.5M range with proven recurring revenue. This listing fits our investment thesis at ${CONFIG.buyer.companyName} — happy to access the full details and evaluate further. Open to discussing timing and process directly.

Best,
${CONFIG.buyer.signerFullName}
${CONFIG.buyer.signerTitle}, ${CONFIG.buyer.companyName}
${CONFIG.buyer.signerEmail}
`.trim();

export async function signNdaOnFlippa(
  context: BrowserContext,
  listingUrl: string
): Promise<NdaSignResult> {
  const page = await context.newPage();
  try {
    log.info(`NDA sign: navegando a ${listingUrl}`);
    await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await humanDelay(1500, 3000);

    // Step 1: aceptar checkbox + "Sign NDA and Continue"
    const ok1 = await signStepOne(page);
    if (!ok1) {
      return { signed: false, error: 'No se pudo completar Step 1 (NDA acceptance)' };
    }

    // Step 2: form de acquisition details + submit
    const ok2 = await signStepTwo(page);
    if (!ok2) {
      return { signed: false, error: 'No se pudo completar Step 2 (acquisition form)' };
    }

    // Verificar confirmación (heurística: aparece texto "pending approval" o el NDA section desaparece)
    await humanDelay(2000, 4000);
    const confirmed = await verifySigned(page);
    if (!confirmed) {
      return { signed: false, error: 'Submit ejecutado pero sin confirmación visible — manual review needed' };
    }

    log.info(`NDA sign: ✅ firmado OK`);
    return { signed: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`NDA sign failed for ${listingUrl}`, err);
    return { signed: false, error: msg };
  } finally {
    await page.close();
  }
}

async function signStepOne(page: Page): Promise<boolean> {
  // Checkbox de "I accept the terms..." — usar Locator con texto cercano
  const checkbox = page.locator(
    'input[type="checkbox"]:near(:text("I accept")), input[type="checkbox"]:near(:text("accept the terms"))'
  ).first();

  try {
    await checkbox.waitFor({ state: 'visible', timeout: 10_000 });
    await checkbox.check();
    await humanDelay(500, 1500);
  } catch {
    log.warn('NDA sign Step 1: no encontré checkbox de aceptación');
    return false;
  }

  // Botón "Sign NDA and Continue"
  const button = page.locator(
    'button:has-text("Sign NDA and Continue"), button:has-text("Sign NDA & Continue"), button:has-text("Sign NDA")'
  ).first();
  try {
    await button.click({ timeout: 10_000 });
  } catch {
    log.warn('NDA sign Step 1: no encontré botón Sign NDA and Continue');
    return false;
  }

  await humanDelay(2000, 4000);
  return true;
}

async function signStepTwo(page: Page): Promise<boolean> {
  // Dropdown: acquisition process & timeline
  try {
    const sel1 = page.locator('select').nth(0);
    await sel1.waitFor({ state: 'visible', timeout: 10_000 });
    await sel1.selectOption({ label: ACQUISITION_TIMELINE }).catch(async () => {
      // Fallback: seleccionar la primera opción que parezca "actively buying"
      const options = await sel1.locator('option').allTextContents();
      const match = options.find((t) => /actively buying/i.test(t));
      if (match) await sel1.selectOption({ label: match });
    });
    await humanDelay(400, 1000);

    // Dropdown: how would you fund this deal
    const sel2 = page.locator('select').nth(1);
    await sel2.selectOption({ label: FUND_SOURCE }).catch(async () => {
      const options = await sel2.locator('option').allTextContents();
      const match = options.find((t) => /corporate|fund|family office/i.test(t));
      if (match) await sel2.selectOption({ label: match });
    });
    await humanDelay(400, 1000);

    // Textarea: message for seller
    const textarea = page.locator('textarea').first();
    await textarea.fill(MESSAGE_FOR_SELLER);
    await humanDelay(800, 1800);

    // Submit
    const submitBtn = page.locator(
      'button:has-text("Submit NDA"), button:has-text("Submit"), button[type="submit"]'
    ).first();
    await submitBtn.click({ timeout: 10_000 });
    return true;
  } catch (err) {
    log.warn('NDA sign Step 2: error', { err: String(err) });
    return false;
  }
}

async function verifySigned(page: Page): Promise<boolean> {
  // Heurísticas: buscar "pending approval", "thank you", "submitted", o ausencia del form
  const html = await page.content();
  const lower = html.toLowerCase();
  const signals = ['pending approval', 'awaiting approval', 'thank you', 'nda submitted', 'we received your nda', 'submitted successfully'];
  return signals.some((s) => lower.includes(s));
}
