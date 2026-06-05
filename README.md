# Business Sourcing Scrapers

Pipeline de Task 1 (scrapeo automatizado) de la búsqueda de deals SaaS USA $750K-1.5M.

Corre diariamente en GitHub Actions, scrapea sitios logueado vía Playwright, dedupea
contra Google Sheet y deja listings nuevos marcados como `needs_nda_review=TRUE` para
que Task 2 (revisión NDA) los tome.

## Estructura

```
src/
├── index.ts             # entry point — orquesta scrape + sheet + notify
├── config.ts            # env vars
├── types.ts             # NormalizedListing, ListingRow, ScraperResult
├── scrapers/
│   └── flippa.ts        # Playwright login + API replay
├── sheets/
│   └── writer.ts        # upsert con dedup, Run_Log
├── notify/
│   └── email.ts         # SMTP (Gmail) — notifica si N fails seguidos
└── utils/
    └── log.ts           # logger + humanDelay
```

## Tabs en la Google Sheet

- **Scraper_Inflow** — todos los listings (uno por fila). Clave: `(source, listing_id)`.
- **Run_Log** — una fila por corrida por source. Para detectar anomalías.

## Variables (GitHub Secrets)

| Secret | Para |
|---|---|
| `SHEET_ID` | ID de la Google Sheet |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | JSON del Service Account con acceso Editor a la Sheet |
| `FLIPPA_EMAIL` / `FLIPPA_PASSWORD` | credenciales de cuenta verificada de Flippa |
| `SMTP_USER` / `SMTP_APP_PASSWORD` | Gmail sender (con 2FA + app password) |
| `NOTIFY_EMAIL` | destinatario de alertas |

## Correr localmente

```bash
npm install
npx playwright install chromium
cp .env.example .env  # llenar valores
npx tsx src/index.ts flippa
```

## Schedule

GitHub Actions diario a las 7:00 UTC (~3 AM US ET). Trigger manual desde la
pestaña Actions del repo (botón "Run workflow").

## Decisiones de diseño

Ver `Task1_Scraping_Decisiones.md` en `/Users/lautarosoliani/workspace/`.

## Pre-requisitos para Flippa

El scraper loguea con email + password, **no con Google OAuth** (Google bloquea
browsers automatizados). Si la cuenta se creó con Sign-In with Google, hay que
**setear una password** desde Flippa Account Settings o vía "Forgot password" →
el email recibe link de reset. Después la cuenta puede loguear de ambas formas.

## ToS y baneo

Scraping con cuenta propia logueada viola los Terms of Service de Flippa.
Riesgo realista: baneo de la cuenta de Lautaro (decidido aceptar como
trade-off del experimento). Mitigaciones implementadas:

- 1 corrida/día como máximo
- Delays humanos (800-2500ms entre acciones, 1.5-3.5s entre páginas de API)
- User-Agent realista
- Viewport realista
- `--disable-blink-features=AutomationControlled`

## Próximos pasos

- Sumar BizScout (Task 1 módulo 2)
- Task 2: revisión NDA (skill propio)
- Task 3: firma de NDA (con verificaciones legales)
- Task 4: monitoreo de aprobación
- Task 5: scrapeo de deal info post-NDA + populate Sheet con detalle
