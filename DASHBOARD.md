# Compliance Dashboard

Een responsive Vue.js dashboard voor het bekijken van EU cosmetics compliance-bevindingen — geoptimaliseerd voor desktop, tablet en iPhone.

## 🚀 Deployment / Hosting

### Eigen server (DigitalOcean Droplet)

**Beste voor interne use** — product data blijft privé, geen afhankelijkheid van GitHub Pages.

```bash
npm run dashboard
```

Dashboard: `http://<droplet-ip>` (via Nginx-reverse-proxy naar poort 3000, zie `setup-server.sh`)

- GitHub Token automatisch gebruikt (server-side, veilig)
- Wordt na elke succesvolle workflow-run automatisch bijgewerkt via de
  deploy-webhook (zie hieronder)

> **Niet meer via GitHub Pages**: dat was de eerdere hostingroute maar is
> verwijderd uit de workflow — de Droplet + webhook is nu de enige
> hostingmethode. Onnodige complexiteit (en een losse faalbron als Pages
> niet correct staat ingeschakeld) is zo weg.

## 📱 Features

- **Responsive design**: Werkt perfect op iPhone, tablet en desktop
- **Real-time data**: Laadt automatisch `violations-latest.json` van de reports
- **Filtering**: Zoeken op status (verboden/beperkt), merk, ingrediënt
- **Summary cards**: Overzicht van totaal, verboden, beperkt, zonder INCI
- **Timestamp**: Toont wanneer de scan is gedraaid (ISO datetime)
- **Update knop**: Start workflow handmatig (vereist GitHub token)

## 🔄 Workflow Triggeren

De "Update" knop in het dashboard kan de compliance-scan handmatig starten.

### Met lokale server (aanbevolen)

Server gebruikt automatisch `GITHUB_TOKEN` environment variable:

```bash
GITHUB_TOKEN=ghp_xxxx npm run dashboard
```

"Update" knop werkt dan automatisch (geen extra setup nodig).

### Met GitHub Pages

Geen extra setup nodig — workflow token is beschikbaar in GitHub Actions.

Elke workflow run (maandelijks of handmatig) update het dashboard automatisch.

## 🔁 Automatische herdeploy na een run

Na elke succesvolle workflow-run roept GitHub Actions een webhook aan op de
server, die meteen `git pull` + `pm2 restart` doet. Zo hoef je na het klikken
op "Update" niet meer zelf in te loggen op de server om de nieuwe data te
zien — dat gebeurt binnen enkele seconden na afloop van de run.

### Eenmalige setup

1. **Genereer een geheim** (bijvoorbeeld met `openssl rand -hex 32`).
2. **GitHub repo secrets** (Settings → Secrets and variables → Actions):
   - `DEPLOY_WEBHOOK_URL` → `http://<droplet-ip>/api/webhook-deploy`
   - `DEPLOY_WEBHOOK_SECRET` → hetzelfde geheim als hierboven
3. **Op de server**, herstart de app met dat geheim als environment variable:
   ```bash
   cd /apps/byleijtens-compliance-agent
   DEPLOY_WEBHOOK_SECRET="<zelfde geheim>" GITHUB_TOKEN="<bestaande token>" GITHUB_REPOSITORY="WillemLeijtens/byleijtens-compliance-agent" pm2 start server.js --name compliance-agent
   pm2 save
   ```
   (of `pm2 restart compliance-agent --update-env` als het proces al met de
   overige env vars draait en je alleen `DEPLOY_WEBHOOK_SECRET` toevoegt)

Zonder `DEPLOY_WEBHOOK_SECRET` op de server blijft het endpoint uitgeschakeld
(geeft altijd 404) — de rest van het dashboard blijft gewoon werken.

## 📈 Status-indicatoren

Het dashboard toont naast de tellingen ook:
- **Laatste run**: tijdstip + of de laatste workflow-run succesvol was, mislukt is, of nog loopt.
- **Shopify-koppeling**: afgeleid van de conclusie van de "Sync + scan + rapport"-stap in die laatste run — geen secret-*waarden* worden ooit gelezen, alleen of die stap slaagde of faalde.

Dit komt van een nieuw `/api/status`-endpoint in `server.js`, dat de GitHub
Actions API bevraagt met dezelfde `GITHUB_TOKEN` die ook de "Update"-knop
gebruikt.

## 📊 Data Structuur

Dashboard leest uit: `reports/violations-latest.json`

```json
{
  "lastScan": "2026-07-18T10:30:45.123Z",
  "counts": {
    "verboden": 8,
    "beperkt": 71,
    "geen-inci": 10,
    "ok": 5365,
    "totaal": 5454
  },
  "violations": [
    {
      "sku": "SKU123",
      "title": "Product Name",
      "brand": "Merk",
      "status": "verboden|beperkt",
      "hits": [
        {
          "inci": "Ingredient Name",
          "cas": "123-45-6",
          "annex": "II|III",
          "ref": "(EU) 2021/1902",
          "note": "Optional details",
          "via": "INCI|CAS"
        }
      ]
    }
  ]
}
```

## 🎨 Aanpassen

Dashboard-code staat in `index.html` (Vue.js + Tailwind CSS).

Wijzigingen aanpassen:
1. Edit `index.html` of `dashboard.html`
2. Commit en push
3. GitHub Actions deployt automatisch

## ❓ Troubleshooting

### "Geen scans gevonden"
- Voer eerst handmatig een scan uit (Actions tab → "Run workflow")
- Wacht tot workflow klaar is
- Refresh dashboard

### "Update knop werkt niet"
- Token nodig: zie **Workflow Triggeren** hierboven
- Check browser console (F12) op errors
- Token moet `repo` scope hebben

### Reports niet zichtbaar
- Zorg dat `reports/` geopend wordt in workflow commits
- Check `.github/workflows/monthly-compliance-check.yml` → `git add reports/`

## 📝 Handmatig starten

Ook mogelijk via GitHub Actions UI:
1. Repo → **Actions** tab
2. Workflow: "Maandelijkse compliance-check"
3. **Run workflow** → **Run workflow**

## 🔗 Links

- [Vue.js docs](https://vuejs.org/)
- [Tailwind CSS](https://tailwindcss.com/)
- [GitHub Pages](https://pages.github.com/)
