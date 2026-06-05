/**
 * Notificador de fallos vía SMTP (Gmail).
 *
 * Política (definida en Task1_Scraping_Decisiones.md):
 *   - Solo notifica si los últimos N runs consecutivos fallaron.
 *   - Esto evita ruido por fallos transitorios (red, rate-limit puntual).
 */

import nodemailer from 'nodemailer';
import { CONFIG, canNotify } from '../config.js';
import { log } from '../utils/log.js';
import { getRecentRunLog } from '../sheets/writer.js';
import type { Source } from '../types.js';

export async function maybeNotifyFailure(source: Source, errorMessage: string): Promise<void> {
  if (!canNotify()) {
    log.warn('Notify: SMTP no configurado, skipping email');
    return;
  }

  // Check consecutive failures
  const recent = await getRecentRunLog(source, CONFIG.notify.failuresBeforeAlert);
  const allFailed =
    recent.length >= CONFIG.notify.failuresBeforeAlert &&
    recent.every((e) => e.status === 'error');

  if (!allFailed) {
    log.info(
      `Notify: ${recent.length} fallos recientes para ${source}, ` +
      `umbral=${CONFIG.notify.failuresBeforeAlert}. No notifico todavía.`
    );
    return;
  }

  log.warn(`Notify: enviando email de alerta para ${source}`);
  await sendMail(source, errorMessage, recent);
}

async function sendMail(source: Source, currentError: string, recent: any[]): Promise<void> {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: CONFIG.notify.smtpUser!,
      pass: CONFIG.notify.smtpAppPassword!,
    },
  });

  const subject = `[Scrapers] ${source} falló ${recent.length} corridas seguidas`;
  const body = [
    `Source: ${source}`,
    `Último error: ${currentError}`,
    '',
    `Últimas ${recent.length} corridas:`,
    ...recent.map((r) => `  ${r.timestamp} — ${r.status} — ${r.error_message || '(sin mensaje)'}`),
    '',
    'Acción recomendada: revisar logs en GitHub Actions del repo business-sourcing-scrapers.',
  ].join('\n');

  await transporter.sendMail({
    from: CONFIG.notify.smtpUser,
    to: CONFIG.notify.notifyEmail,
    subject,
    text: body,
  });
  log.info(`Notify: email enviado a ${CONFIG.notify.notifyEmail}`);
}
