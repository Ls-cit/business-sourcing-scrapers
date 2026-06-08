/**
 * Manda email con el draft del pushback (cuando NDA review es 🟡 o 🔴).
 * El destinatario es NOTIFY_EMAIL (codingit5@gmail.com) — Lautaro reenvía a Francisco si corresponde.
 */

import nodemailer from 'nodemailer';
import { CONFIG, canNotify } from '../config.js';
import { log } from '../utils/log.js';

export interface PushbackEmailInput {
  listingId: string;
  listingTitle: string;
  listingUrl: string;
  verdict: 'YELLOW' | 'RED' | 'GREEN' | '';
  rationale: string;
  pushbackBody: string;
}

export async function sendPushbackEmail(input: PushbackEmailInput): Promise<void> {
  if (!canNotify()) {
    log.warn('Pushback email: SMTP no configurado — skip');
    return;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: CONFIG.notify.smtpUser!, pass: CONFIG.notify.smtpAppPassword! },
  });

  const colorTag = input.verdict === 'RED' ? '🔴' : input.verdict === 'YELLOW' ? '🟡' : '⚪';
  const subject = `${colorTag} NDA needs pushback: ${input.listingTitle.slice(0, 80)}`;

  const body = [
    `Listing: ${input.listingTitle}`,
    `URL: ${input.listingUrl}`,
    `Listing ID: ${input.listingId}`,
    `Verdict: ${input.verdict}`,
    '',
    `Rationale: ${input.rationale}`,
    '',
    '— — — — — — — — — — — — — — — — — — — — — — — — — —',
    'Draft de email al broker (revisar y enviar manualmente):',
    '— — — — — — — — — — — — — — — — — — — — — — — — — —',
    '',
    input.pushbackBody,
    '',
    '— — — — — — — — — — — — — — — — — — — — — — — — — —',
    'Generado automáticamente por business-sourcing-scrapers.',
  ].join('\n');

  await transporter.sendMail({
    from: CONFIG.notify.smtpUser,
    to: CONFIG.notify.notifyEmail,
    subject,
    text: body,
  });
  log.info(`Pushback email enviado para listing ${input.listingId}`);
}
