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
- **Filtering**: Zoeken op status (verboden/beperkt/toegestaan/conform), merk,
  ingrediënt
- **Summary cards**: Totaal, verboden (II), beperkt (III), toegestaan (IV–VI),
  zonder INCI
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

## 🧪 Handmatige INCI-check (tabblad 2)

Naast de Shopify-catalogus zit een tweede tabblad waarin je een losse
INCI-lijst kunt controleren — bijvoorbeeld van een product dat nog niet in de
webshop staat, of van een label dat je van een leverancier hebt gekregen.

- Plak de INCI-lijst, vul optioneel een productnaam in, klik **Check**
- Per ingrediënt volgt een oordeel: **Verboden** (Annex II), **Beperkt**
  (Annex III), **Aangegeven** (geurallergeen met alleen een aangifteplicht),
  **Toegestaan** (Annex IV/V/VI) of **Geen match**
- **Opslaan** bewaart de controle; opgeslagen controles kun je weer
  **Verwijderen**

Deze functie gebruikt dezelfde normalisatie, splitsing en stoffenlijst als de
automatische scan (`checkInciList` in `src/compliance.js`), zodat handmatige
en automatische controle nooit tegenstrijdige uitkomsten geven.

### Gescheiden van de productdatabase

Bewust volledig losgekoppeld van de Shopify-gegevens:

| | Shopify-catalogus | Handmatige check |
|---|---|---|
| Bron | `reports/violations-latest.json` (workflow) | wat je zelf plakt |
| Opslag | `reports/` (in git) | `data/manual-checks.json` (**buiten** git) |
| Endpoints | `/api/status` | `/api/inci-check`, `/api/manual-checks` |

`data/manual-checks.json` staat in `.gitignore`. Dat is bewust: de
deploy-webhook doet `git pull`, en een lokaal gewijzigd, getrackt databestand
zou die pull laten stuklopen.

### Stoffenlijst importeren uit CosIng

`data/prohibited-list.json` is te vullen vanuit de officiële annexen in plaats
van met de hand. De annexen worden regelmatig gewijzigd (Omnibus-verordeningen),
dus dit is bewust een herhaalbare import en geen eenmalige momentopname.

1. Download op https://ec.europa.eu/growth/tools-databases/cosing/ via
   **menu → Reference data → Annexes** de lijsten als **CSV** (Annex II =
   verboden, Annex III = beperkt; Annex IV/V/VI zijn kleurstoffen,
   conserveermiddelen en UV-filters).
2. Draai de import:

   ```bash
   node scripts/import-cosing.js --annex2 annex2.csv --annex3 annex3.csv
   ```

   Een bron mag ook een URL zijn. Met `--dry-run` zie je eerst wat eruit komt
   zonder iets weg te schrijven.

Het script raadt niets: herkent het een kolom niet, dan meldt het dat expliciet
in plaats van stilzwijgend lege velden op te slaan. Bestaande handmatig
toegevoegde synoniemen blijven behouden (`--no-merge` schakelt dat uit).

Twee dingen die het script bewust doet:

- **De glossary-naam wordt de hoofdnaam.** CosIng geeft per stof zowel
  `Name of Common Ingredients Glossary` ("Benzophenone-3") als
  `Chemical name / INN` ("2-hydroxy-4-methoxybenzophenone"). Op een etiket
  staat de eerste; die moet dus de hoofdnaam zijn, met de chemische naam als
  synoniem. Andersom matcht de lijst juist niet op echte etiketten.
- **Eén naam kan meerdere annexen raken.** CI 14270 staat in Annex II (verbod
  in haarverf) én in Annex IV (toegelaten kleurstof). De index bewaart daarom
  álle regels per naam en het zwaarste oordeel wint. Zou hij er één bewaren,
  dan bepaalt de importvolgorde welke wint en kan een toelating een verbod
  maskeren.
- **De schuine streep is dubbelzinnig.** `Butylparaben/Propylparaben/Sodium
  Propylparaben` is een opsomming; `Saccharomyces/Zinc/Magnesium/Selenium
  Ferment` is één ingrediënt. Beslissend is het laatste deel: draagt dat een
  kopwoord (Ferment, Extract, Oil …), dan zijn de delen ervoor bepalingen en
  geen zelfstandige stoffen. Zonder die regel werd `Zinc` een verboden stof.

De server cachet de lijst op mtime, dus een verse import is direct actief
zonder herstart.

### Wat de uitslag wel en niet zegt

De lijst bevat de volledige Annexen II tot en met VI (2346 stoffen, CosIng
18-08-2026). Toch blijft **"Geen match" geen bewijs dat een ingrediënt is
toegestaan** — alleen dat het niet in deze annexen staat. De UI zegt daarom
"Geen match" en niet "Conform", en verwijst bij elke uitslag naar CosIng.

Drie dingen die de app principieel niet kan beoordelen:

- **Concentraties.** Annex III/V/VI stellen grenzen ("max 1,0 %"); een
  INCI-lijst noemt geen percentages. De limiet staat in de toelichting, de
  toetsing eraan blijft mensenwerk.
- **Producttype.** Veel beperkingen gelden alleen voor rinse-off, alleen voor
  professioneel gebruik, of niet voor kinderen onder de 3.
- **Voorwaardelijke verboden.** Sommige Annex II-regels gelden alleen voor een
  specifieke vorm of een bepaald producttype — `Styrene/Acrylates copolymer
  (nano)`, of `CI 26100 … when used as a substance in hair dye products`. Die
  verschijnen als **beperkt**, met de voorwaarde erbij.

### De vier oordelen

De vijf annexen zijn niet hetzelfde soort lijst, en de app houdt ze uit
elkaar. II verbiedt, III beperkt, maar **IV, V en VI zijn toelatingslijsten**:
artikel 14 verbiedt juist de kleurstoffen, conserveermiddelen en UV-filters
die er *niet* op staan. Een treffer daar is dus een bevestiging, geen
bevinding.

| Oordeel | Waar het vandaan komt |
|---|---|
| **Verboden** | Annex II, zonder uitzondering die op deze stof slaat |
| **Beperkt** | Annex III met een echte grens, of een Annex II-verbod dat alleen voor een vorm of producttype geldt |
| **Aangegeven** | Annex III-geurallergeen waarvan de enige voorwaarde de vermelding op het etiket is — daaraan is voldaan doordat de stof in de INCI-lijst staat |
| **Toegestaan** | Annex IV, V of VI, met de voorwaarden uit de annex erbij |

Alleen **verboden** en **beperkt** zijn bevindingen. Aangegeven en toegestaan
bepalen niet of een product opvalt; anders verdrinkt een echt verbod erin.

Een uitzondering die naar een **andere annex** verwijst ("kwik en zijn
verbindingen, behalve de gevallen in Annex V") heft het verbod niet op: die
uitzondering is een apart genoemde stof, niet degene die hier bij naam staat.
Kwikchloride blijft dus verboden. Verwijst de uitzondering naar een vorm of
producttype, dan wordt het een controlepunt. De voorwaarde staat in CosIng
lang niet altijd in de conditiekolom — net zo vaak in de stofnaam zelf of in
een synoniem, dus de app leest de hele regel.

### Beveiliging

De endpoints volgen hetzelfde model als de rest van de app: oorsprongscontrole
tegen CSRF, identiteit uit de gateway (wie een check opslaat wordt vastgelegd),
een tempolimiet op opslaan en een plafond van 500 bewaarde controles. Checken
en opslaan mag iedereen die door de gateway komt — dat is werk, geen beheer;
alleen het starten van de Shopify-scan blijft beheerders voorbehouden.

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

De app-code staat in `index.html` (Merkenplatform-shell, Vue 3 zonder buildstap).

Wijzigingen aanpassen:
1. Edit `index.html`
2. Commit en push naar `main`
3. Op de Droplet: `git pull origin main && pm2 restart compliance-agent`
   (of automatisch, zodra `DEPLOY_WEBHOOK_URL` in GitHub is gezet)

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

## 🔗 Eén gedeelde stoffenlijst

De Shopify-scan en de handmatige check gebruiken dezelfde bron:
`data/prohibited-list.json`, via dezelfde matchingcode in
`src/compliance.js`. Er is bewust geen tweede lijst — anders zou hetzelfde
ingrediënt op twee plekken een ander oordeel kunnen krijgen.

Ze draaien wel op verschillende machines: de scan in GitHub Actions, de
handmatige check op de Droplet, elk met een eigen kopie van de repository.
Wordt er één bijgewerkt zonder de ander, dan lopen ze uiteen zonder dat je
het merkt.

Daarom rekent `listFingerprint()` een vingerafdruk uit (aantal + hash). De
scan schrijft die in `violations-latest.json`, de server rapporteert de zijne
bij elke check, en het dashboard toont ze naast elkaar — met de melding
"wijkt af" zodra ze verschillen. Na een import hoort de lijst dus gecommit
en op beide plekken uitgerold te worden.
