# Compliance Dashboard

Een responsive Vue.js dashboard voor het bekijken van EU cosmetics compliance-bevindingen — geoptimaliseerd voor desktop, tablet en iPhone.

## 🚀 Deployment / Hosting

### Option A: Lokale server (aanbevolen voor privé repo)

**Beste voor interne use** — product data blijft privé.

```bash
npm run dashboard
```

Dashboard: `http://localhost:3000`

**Voor collega's:**
- Deploy op eigen server/VM
- Deel URL met team
- GitHub Token automatisch gebruikt (server-side, veilig)

---

### Option B: GitHub Pages (repo moet publiek zijn)

Het dashboard kan automatisch naar **GitHub Pages** deployed worden na elke scan.

**Vereiste**: Repo moet public zijn (GitHub Pages werkt niet met privé repos tenzij Enterprise).

#### Stappen:

1. Repo → **Settings** → **Visibility** → **Change to Public**
2. Repo → **Settings** → **Pages**
3. Source: **GitHub Actions** (standaard)
4. Dashboard wordt automatisch gepubliceerd

#### URL

```
https://<jouw-org>.github.io/byleijtens-compliance-agent/
```

Bijvoorbeeld: `https://willemleijtens.github.io/byleijtens-compliance-agent/`

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
