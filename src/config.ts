/**
 * Config central: lee env vars y valida que estén presentes.
 * Mismas vars sirven local (via .env + tsx) y en GitHub Actions (via Secrets).
 */

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function opt(name: string): string | undefined {
  return process.env[name];
}

export const CONFIG = {
  sheets: {
    spreadsheetId: req('SHEET_ID'),
    serviceAccountJson: req('GOOGLE_SERVICE_ACCOUNT_JSON'),
    tabInflow: 'Scraper_Inflow',
    tabRunLog: 'Run_Log',
  },

  flippa: {
    email: opt('FLIPPA_EMAIL'),
    password: opt('FLIPPA_PASSWORD'),
    // Filtros del cliente — fijos por ahora (decisión en Task1_Scraping_Decisiones.md)
    filters: {
      propertyType: 'saas',
      priceMin: 750000,
      priceMax: 1500000,
      country: 'United States',
      onlyOpen: true,
    },
  },

  notify: {
    smtpUser: opt('SMTP_USER'),
    smtpAppPassword: opt('SMTP_APP_PASSWORD'),
    notifyEmail: opt('NOTIFY_EMAIL'),
    // Cuántas corridas fallidas seguidas antes de notificar
    failuresBeforeAlert: 2,
  },

  // Behavior
  isCi: process.env.GITHUB_ACTIONS === 'true',
};

/** True si tenemos todo para mandar email de alerta. */
export function canNotify(): boolean {
  return !!(CONFIG.notify.smtpUser && CONFIG.notify.smtpAppPassword && CONFIG.notify.notifyEmail);
}
