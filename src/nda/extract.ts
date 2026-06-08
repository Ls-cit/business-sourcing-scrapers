/**
 * Extrae el texto del NDA de un listing de Flippa (logueado).
 *
 * Flujo: navegar al listing → encontrar la sección "Sign NDA" → extraer texto.
 * En Flippa, el NDA aparece embedded en la página de detalle bajo un
 * <h?>NON-DISCLOSURE AGREEMENT</h?> + bloque de texto + checkbox + botón.
 */

import type { BrowserContext } from 'playwright';
import { log, humanDelay } from '../utils/log.js';

export interface NdaExtractResult {
  /** Texto del NDA o '' si no se encontró */
  ndaText: string;
  /** true si la página tenía un módulo de NDA visible */
  hasNda: boolean;
  /** Mensaje de error si algo falla */
  error?: string;
}

export async function extractNdaFromListing(
  context: BrowserContext,
  listingUrl: string
): Promise<NdaExtractResult> {
  const page = await context.newPage();
  try {
    log.info(`NDA extract: navegando a ${listingUrl}`);
    await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await humanDelay(1500, 3000);

    // Estrategia: buscar el bloque NDA por keywords. Flippa lo renderiza con
    // "NON-DISCLOSURE AGREEMENT" como heading + texto debajo.
    const result = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('*')).filter((el) => {
        const t = (el.textContent || '').toUpperCase();
        return t.includes('NON-DISCLOSURE AGREEMENT') && t.length < 30_000;
      });

      if (candidates.length === 0) return { hasNda: false, ndaText: '' };

      // Tomar el container más chico que tenga el texto NDA — típicamente un <div> con la cláusula
      // Subir al ancestro común que tiene el texto del agreement
      const text = candidates
        .map((el) => el.textContent || '')
        .reduce((shortest, t) => (t.length < shortest.length || shortest === '' ? t : shortest), '');

      return { hasNda: true, ndaText: text.trim() };
    });

    if (!result.hasNda) {
      log.warn(`NDA extract: ${listingUrl} no muestra NDA visible (puede requerir click previo)`);
      return { hasNda: false, ndaText: '' };
    }

    // Limpiar whitespace excesivo
    const cleaned = result.ndaText.replace(/\n{3,}/g, '\n\n').trim();
    log.info(`NDA extract: ${cleaned.length} chars`);
    return { hasNda: true, ndaText: cleaned };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`NDA extract failed for ${listingUrl}`, err);
    return { hasNda: false, ndaText: '', error: msg };
  } finally {
    await page.close();
  }
}
