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

  // Anthropic API para análisis automatizado de NDAs (Task 2)
  anthropic: {
    apiKey: opt('ANTHROPIC_API_KEY'),
    // Sonnet 4.6 — balance costo/calidad para revisión legal
    model: 'claude-sonnet-4-6',
    maxTokens: 4000,
  },

  // NDA behavior flags
  nda: {
    /** Si true: review sí, sign NO. Marca verdict en sheet, deja nda_signed=false.
     *  Útil para validar verdicts antes de comprometerse legalmente con firmas. */
    dryRun: opt('NDA_DRY_RUN') === 'true',
  },

  // Datos canónicos para llenar NDAs (decisión: signer Francisco, contact codingit5)
  buyer: {
    companyName: 'CodingIT LLC',
    companyType: 'Limited Liability Company',
    address: '710 Arrow Point Dr, Unit 30',
    city: 'Cedar Park',
    state: 'Texas',
    stateAbbr: 'TX',
    zip: '78613',
    country: 'United States',
    website: 'https://codingit.dev',
    industry: 'Nearshore software development services and strategic acquisitions',
    // Signer
    signerFirstName: 'Francisco',
    signerLastName: 'Rico',
    signerFullName: 'Francisco Javier Rico',
    signerTitle: 'Head of M&A and Strategic Growth',
    signerPhone: '+1 512 640-5758',
    // Email del NDA → codingit5 para aislamiento del dominio (decisión 2026-06)
    signerEmail: 'codingit5@gmail.com',
    linkedin: 'https://www.linkedin.com/in/francisco-rico',
  },

  // Behavior
  isCi: process.env.GITHUB_ACTIONS === 'true',
};

/** True si tenemos todo para mandar email de alerta. */
export function canNotify(): boolean {
  return !!(CONFIG.notify.smtpUser && CONFIG.notify.smtpAppPassword && CONFIG.notify.notifyEmail);
}
