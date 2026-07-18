# By Leijtens — EU Cosmetics Compliance Agent

Haalt maandelijks automatisch de productcatalogus op uit Shopify (titel, SKU,
merk, omschrijving, en de **Ingrediënten**-metafield), matcht die tegen de
verboden/beperkte stoffenlijst van EU Verordening (EG) 1223/2009 (Annex II/III),
en rapporteert de bevindingen — zonder dat iemand iets hoeft te plakken of te
klikken.

## Architectuur

```
src/
  config.js        configuratie uit environment variables
  shopify.js        Shopify Admin GraphQL-client (retry, throttling, resumable)
  compliance.js      deterministische INCI/CAS-matching tegen de lijst
  report.js          Markdown-rapport
  github-issue.js     opent een GitHub Issue bij bevindingen
  index.js           orchestrator: sync → scan → rapport → issue
  update-list.js     (optioneel) AI-check op nieuwe Annex II/III-wijzigingen
data/
  prohibited-list.json  de verboden/beperkte-stoffenlijst
reports/
  products-*.json, violations-*.json, report-*.md, report-latest.md
```

## Eenmalige setup

### 1 · Shopify Admin API-token

1. Shopify admin → Instellingen → Apps en verkoopkanalen → Apps ontwikkelen → App maken
2. Configuratie → Admin API scopes: minimaal `read_products`
3. **Geef de app ook expliciete leestoegang tot de `custom`-metafield-namespace**
   (zelfde scherm, "metafield access") — anders komt de Ingrediënten-waarde
   leeg terug, ook al staat hij in de Shopify admin wél gevuld.
4. Installeer de app → kopieer het Admin API-token (`shpat_...`)

### 2 · Repo aanmaken op GitHub

```bash
cd byleijtens-compliance-agent
git init
git add .
git commit -m "Initial commit: compliance agent"
git remote add origin https://github.com/<jouw-org>/byleijtens-compliance-agent.git
git push -u origin main
```

### 3 · Secrets instellen

Repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Waarde |
|---|---|
| `SHOPIFY_STORE_DOMAIN` | `byleijtens.myshopify.com` |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | het token uit stap 1 |

`GITHUB_TOKEN` hoef je niet zelf aan te maken — die geeft GitHub Actions
automatisch mee.

### 4 · Eerste run

Repo → tab **Actions** → workflow "Maandelijkse compliance-check" →
**Run workflow** (handmatig, via `workflow_dispatch`). Daarna draait hij
vanzelf op de 1e van elke maand, 06:00 UTC.

Resultaten komen in `reports/` terecht en worden automatisch gecommit.
Bij bevindingen (verboden of beperkte stoffen) opent de workflow ook een
**GitHub Issue** met het volledige rapport — dat is je notificatie, zonder
dat er e-mail/SMTP hoeft te worden ingericht.

## Lokaal draaien

```bash
npm install
cp .env.example .env   # invullen
npm run sync
```

## Optioneel: lijst automatisch bijwerken

`src/update-list.js` controleert via de Anthropic API (met web search) op
nieuwe Annex II/III-wijzigingen. Dit vereist een eigen `ANTHROPIC_API_KEY`
(los van een Claude-abonnement, betaald per gebruik). Draai dit handmatig
of kwartaal, review de wijzigingen in `data/prohibited-list.json`, en commit
zelf — dit gebeurt bewust niet automatisch zonder review, omdat het om een
juridisch relevante lijst gaat.

```bash
ANTHROPIC_API_KEY=sk-ant-xxxx npm run update-list
```

## Beheer & onderhoud

- **Shopify API-versie** (`SHOPIFY_API_VERSION` in de secrets/`.env`):
  Shopify versioneert per kwartaal en ondersteunt een versie ~1 jaar.
  Controleer periodiek https://shopify.dev/docs/api/admin-graphql en werk bij.
- **Uitval opmerken**: als de Shopify-sync faalt, eindigt de workflow met een
  rode X in de Actions-tab (non-zero exit code) — zet daar eventueel een
  GitHub-notificatie op, of koppel een externe monitor (bv. healthchecks.io)
  aan een aparte "ping"-stap.
- **`FAIL_ON_VIOLATION=true`** zet je in de secrets als je wilt dat de Action
  zelf ook rood uitslaat bij gevonden verboden stoffen (naast de Issue).

## Dit is geen juridisch advies

Interne beslissingsondersteuning op basis van CosIng / EUR-Lex (EG) 1223/2009.
