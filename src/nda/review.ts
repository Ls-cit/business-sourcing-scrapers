/**
 * NDA Review via Anthropic API.
 *
 * Toma el texto del NDA, lo manda con el prompt del skill adaptado, y devuelve
 * un NdaReviewResult parseado del JSON que devuelve el modelo.
 */

import Anthropic from '@anthropic-ai/sdk';
import { CONFIG } from '../config.js';
import { log } from '../utils/log.js';
import { NDA_REVIEW_SYSTEM_PROMPT, buildUserMessage } from './prompt.js';
import type { NdaReviewResult, NdaVerdict } from '../types.js';

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client) return _client;
  if (!CONFIG.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY no seteado — Task 2 (review) no puede correr');
  }
  _client = new Anthropic({ apiKey: CONFIG.anthropic.apiKey });
  return _client;
}

export async function reviewNda(ndaText: string): Promise<NdaReviewResult> {
  const client = getClient();
  log.info(`NDA review: enviando ${ndaText.length} chars a ${CONFIG.anthropic.model}`);

  const resp = await client.messages.create({
    model: CONFIG.anthropic.model,
    max_tokens: CONFIG.anthropic.maxTokens,
    system: NDA_REVIEW_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserMessage(ndaText) }],
  });

  // Concat text blocks
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  // Parse strict JSON. Si el modelo wrapeó en ```json ... ``` lo limpiamos defensivamente.
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  let parsed: NdaReviewResult;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    log.error('NDA review: respuesta no es JSON parseable', { snippet: text.slice(0, 400) });
    throw new Error('NDA review: modelo devolvió respuesta no parseable');
  }

  // Validar shape mínimo
  if (!isValidVerdict(parsed.verdict)) {
    throw new Error(`NDA review: verdict inválido "${parsed.verdict}"`);
  }
  parsed.rationale = parsed.rationale || '';
  parsed.clauses_notable = Array.isArray(parsed.clauses_notable) ? parsed.clauses_notable : [];
  parsed.pushback_email = parsed.pushback_email || '';

  // Sanity: si verdict es GREEN, pushback_email debería ser vacío
  if (parsed.verdict === 'GREEN' && parsed.pushback_email) {
    log.warn('NDA review: verdict GREEN pero pushback_email no vacío. Lo descarto.');
    parsed.pushback_email = '';
  }
  if (parsed.verdict !== 'GREEN' && !parsed.pushback_email) {
    log.warn(`NDA review: verdict ${parsed.verdict} pero pushback_email vacío`);
  }

  log.info(`NDA review: verdict=${parsed.verdict}, clauses notables=${parsed.clauses_notable.length}`);
  return parsed;
}

function isValidVerdict(v: any): v is NdaVerdict {
  return v === 'GREEN' || v === 'YELLOW' || v === 'RED';
}
