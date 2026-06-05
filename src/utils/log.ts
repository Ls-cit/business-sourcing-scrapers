/**
 * Logger simple con timestamp + nivel. Sin dependencias.
 */

function ts(): string {
  return new Date().toISOString();
}

export const log = {
  info: (msg: string, meta?: object) => {
    console.log(`[${ts()}] INFO  ${msg}`, meta ? JSON.stringify(meta) : '');
  },
  warn: (msg: string, meta?: object) => {
    console.warn(`[${ts()}] WARN  ${msg}`, meta ? JSON.stringify(meta) : '');
  },
  error: (msg: string, err?: unknown) => {
    const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    console.error(`[${ts()}] ERROR ${msg}`, err ? errMsg : '');
  },
};

/** Sleep humano-pace (con jitter) para no parecer bot. */
export async function humanDelay(minMs = 800, maxMs = 2500): Promise<void> {
  const delay = minMs + Math.floor(Math.random() * (maxMs - minMs));
  return new Promise((r) => setTimeout(r, delay));
}
