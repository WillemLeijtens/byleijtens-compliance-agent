#!/usr/bin/env node
/**
 * Bouwt data/prohibited-list.json uit de officiële CosIng-annexen.
 *
 * De annexen van Verordening (EG) 1223/2009 worden regelmatig gewijzigd
 * (Omnibus-verordeningen). Daarom importeren we ze in plaats van ze met de
 * hand bij te houden: dit script is opnieuw te draaien zodra de Commissie een
 * nieuwe versie publiceert.
 *
 * Gebruik:
 *   node scripts/import-cosing.js --annex2 <bron> --annex3 <bron> [...]
 *
 * Een <bron> is een URL of een pad naar een lokaal gedownload CSV-bestand.
 * Downloaden kan op https://ec.europa.eu/growth/tools-databases/cosing/
 * (menu → Reference data → Annexes → knop CSV).
 *
 * Opties:
 *   --annex2/--annex3/--annex4/--annex5/--annex6  bron per annex
 *   --out <pad>     doelbestand (standaard data/prohibited-list.json)
 *   --merge         bestaande handmatige synoniemen behouden (standaard aan)
 *   --dry-run       niets wegschrijven, alleen rapporteren
 *
 * Het script raadt niets: herkent het een kolom niet, dan meldt het dat en
 * stopt, in plaats van stilzwijgend lege velden weg te schrijven.
 */

const fs = require("fs");
const path = require("path");

const OUT_DEFAULT = path.join(__dirname, "..", "data", "prohibited-list.json");

// ---------------------------------------------------------------- CSV lezen

/** Minimale maar correcte CSV-parser: quotes, ingesloten scheidingstekens en
 *  verdubbelde quotes ("") worden afgehandeld. */
function parseCsv(tekst, scheider) {
  const rijen = [];
  let rij = [];
  let veld = "";
  let inQuotes = false;

  for (let i = 0; i < tekst.length; i++) {
    const c = tekst[i];

    if (inQuotes) {
      if (c === '"') {
        if (tekst[i + 1] === '"') { veld += '"'; i++; }
        else inQuotes = false;
      } else veld += c;
      continue;
    }

    if (c === '"') { inQuotes = true; continue; }
    if (c === scheider) { rij.push(veld); veld = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { rij.push(veld); rijen.push(rij); rij = []; veld = ""; continue; }
    veld += c;
  }
  if (veld !== "" || rij.length) { rij.push(veld); rijen.push(rij); }
  return rijen.filter((r) => r.some((v) => String(v).trim() !== ""));
}

/** EU-exports gebruiken vaak puntkomma's. Kies de scheider die de kopregel
 *  in de meeste kolommen opdeelt. */
function raadScheider(tekst) {
  const eersteRegel = tekst.split(/\r?\n/)[0] || "";
  const kandidaten = [";", ",", "\t"];
  return kandidaten
    .map((s) => ({ s, n: eersteRegel.split(s).length }))
    .sort((a, b) => b.n - a.n)[0].s;
}

// ------------------------------------------------------------ kolommen vinden

const normKop = (s) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Zoekt een kolom op basis van meerdere mogelijke benamingen. */
function vindKolom(koppen, patronen) {
  const genormaliseerd = koppen.map(normKop);
  for (const patroon of patronen) {
    const idx = genormaliseerd.findIndex((k) => k === patroon);
    if (idx !== -1) return idx;
  }
  for (const patroon of patronen) {
    const idx = genormaliseerd.findIndex((k) => k.includes(patroon));
    if (idx !== -1) return idx;
  }
  return -1;
}

/**
 * De naamkolommen zijn bewust gescheiden. CosIng geeft twee namen per stof en
 * het verschil is hier wezenlijk:
 *
 *   Name of Common Ingredients Glossary → "Benzophenone-3"
 *   Chemical name / INN                 → "2-hydroxy-4-methoxybenzophenone"
 *
 * Op een etiket staat de glossary-naam. Die hoort dus de hoofdnaam te zijn,
 * met de chemische naam als synoniem — andersom matcht de lijst juist níet op
 * echte etiketten, en dat is precies waar deze import voor bedoeld is.
 */
const KOLOMMEN = {
  glossary: ["name of common ingredients glossary", "inci name", "common ingredients glossary", "identified ingredients"],
  chem:     ["chemical name inn", "chemical name", "substance name", "name"],
  cas:      ["cas number", "cas no", "cas"],
  ref:      ["reference number", "ref no", "reference", "regulation"],
  max:      ["maximum concentration in ready for use preparation", "maximum concentration", "max concentration"],
  cond:     ["other", "conditions", "wording of conditions of use and warnings", "restrictions"],
  type:     ["product type body parts", "product type", "field of application"],
};

// ------------------------------------------------------------------ omzetten

function leesBron(bron) {
  if (/^https?:\/\//i.test(bron)) {
    return fetch(bron).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} bij ${bron}`);
      return r.text();
    });
  }
  if (!fs.existsSync(bron)) {
    throw new Error(
      `Bestand niet gevonden: ${bron}\n\n` +
      `De CSV's moeten eerst gedownload worden — ze zitten niet in de repository.\n` +
      `Ga naar https://ec.europa.eu/growth/tools-databases/cosing/reference/annexes\n` +
      `kies Annex II en Annex III, en download elk als CSV. Zet die bestanden\n` +
      `vervolgens in ${process.cwd()} of geef het volledige pad op.`
    );
  }
  return Promise.resolve(fs.readFileSync(bron, "utf8"));
}

async function importeerAnnex(bron, annex) {
  const tekst = await leesBron(bron);
  const scheider = raadScheider(tekst);
  const rijen = parseCsv(tekst, scheider);
  if (rijen.length < 2) throw new Error(`${bron}: geen databijen gevonden`);

  const koppen = rijen[0];
  const idx = {};
  for (const [veld, patronen] of Object.entries(KOLOMMEN)) {
    idx[veld] = vindKolom(koppen, patronen);
  }

  if (idx.glossary === -1 && idx.chem === -1) {
    throw new Error(
      `${bron}: kon geen kolom met een stofnaam herkennen.\n` +
      `Gevonden kopregel: ${koppen.join(" | ")}\n` +
      `Voeg de juiste benaming toe aan KOLOMMEN.glossary of KOLOMMEN.chem in dit script.`
    );
  }

  const stoffen = [];
  const overgeslagen = [];

  /**
   * Splitst een cel met meerdere stofnamen.
   *
   * De schuine streep is dubbelzinnig en dat is geen detail:
   *
   *   BUTYLPARABEN/PROPYLPARABEN/SODIUM BUTYLPARABEN  → drie aparte stoffen
   *   SACCHAROMYCES/GOLD FERMENT                      → één INCI-naam
   *
   * Altijd splitsen maakte van gewoon gistferment een verboden stof; nooit
   * splitsen liet de parabenen onvindbaar. Onderscheid: drie of meer delen
   * leest als opsomming, twee als één naam. De volledige tekst blijft
   * daarnaast altijd staan, zodat een naam mét streep ook heel matcht.
   */
  const splitsNamen = (cel) => {
    const regels = String(cel || "")
      .split(/\s*;\s*|\s*\n\s*/)
      .map((x) => x.trim())
      .filter((x) => x && x.toLowerCase() !== "n/a");

    const namen = [];
    for (const regel of regels) {
      namen.push(regel);
      const delen = regel.split(/\s*\/\s*/).map((x) => x.trim()).filter(Boolean);
      if (delen.length >= 3) namen.push(...delen);
    }
    return [...new Set(namen)];
  };

  for (const rij of rijen.slice(1)) {
    const glossaryNamen = idx.glossary !== -1 ? splitsNamen(rij[idx.glossary]) : [];
    const chemNamen = idx.chem !== -1 ? splitsNamen(rij[idx.chem]) : [];

    // Glossary eerst: dat is de naam die op het etiket staat.
    const namen = [...glossaryNamen, ...chemNamen];
    if (!namen.length) { overgeslagen.push(rij); continue; }

    const hoofdnaam = namen[0];
    const synoniemen = [...new Set(namen.slice(1))].filter(
      (n) => n.toLowerCase() !== hoofdnaam.toLowerCase()
    );

    const stukjes = [
      idx.max  !== -1 ? String(rij[idx.max]  || "").trim() : "",
      idx.type !== -1 ? String(rij[idx.type] || "").trim() : "",
      idx.cond !== -1 ? String(rij[idx.cond] || "").trim() : "",
    ].filter((s) => s && s.toLowerCase() !== "n/a");

    // De kolom met INCI-namen laat voorwaarden weg die in de chemische naam
    // wél staan. "Styrene/Acrylates copolymer (nano)" wordt daar
    // "STYRENE/ACRYLATES COPOLYMER" — terwijl alleen de nanovorm verboden is,
    // en het gewone copolymeer volstrekt legaal in tientallen producten zit.
    // Zulke regels als absoluut verbod importeren levert vals alarm op echte
    // producten; markeer ze daarom als voorwaardelijk, zodat de app om
    // controle vraagt in plaats van een verbod te melden.
    const chemVolledig = idx.chem !== -1 ? String(rij[idx.chem] || "") : "";
    const voorwaardelijk = /\b(except|unless|other than|with the exception)\b|\(nano\)/i.test(chemVolledig);
    const voorwaarde = voorwaardelijk ? chemVolledig.replace(/\s+/g, " ").trim().slice(0, 220) : "";

    stoffen.push({
      inci: hoofdnaam,
      cas: idx.cas !== -1 ? String(rij[idx.cas] || "").trim() || null : null,
      annex,
      ref: idx.ref !== -1 ? String(rij[idx.ref] || "").trim() || `Annex ${annex}` : `Annex ${annex}`,
      note: (voorwaardelijk ? `Alleen onder voorwaarde: ${voorwaarde}` : stukjes.join(" · ")).slice(0, 300),
      ...(voorwaardelijk ? { conditional: true } : {}),
      ...(synoniemen.length ? { synonyms: synoniemen } : {}),
    });
  }

  return { stoffen, overgeslagen: overgeslagen.length, koppen, scheider, idx };
}

// ---------------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2);
  const opt = (naam) => {
    const i = args.indexOf(naam);
    return i !== -1 ? args[i + 1] : null;
  };
  const heeft = (naam) => args.includes(naam);

  const bronnen = [
    ["II", opt("--annex2")],
    ["III", opt("--annex3")],
    ["IV", opt("--annex4")],
    ["V", opt("--annex5")],
    ["VI", opt("--annex6")],
  ].filter(([, bron]) => bron);

  if (!bronnen.length) {
    console.error("Geef minstens één bron op, bijv: --annex2 annex2.csv --annex3 annex3.csv");
    console.error("Zie de toelichting bovenin dit bestand.");
    process.exit(1);
  }

  const uit = opt("--out") || OUT_DEFAULT;
  const alles = [];

  for (const [annex, bron] of bronnen) {
    process.stdout.write(`Annex ${annex} uit ${bron} … `);
    const r = await importeerAnnex(bron, annex);
    console.log(`${r.stoffen.length} stoffen (scheider "${r.scheider}", ${r.overgeslagen} rijen zonder naam overgeslagen)`);
    const ontbrekend = Object.entries(r.idx).filter(([, v]) => v === -1).map(([k]) => k);
    if (ontbrekend.length) console.log(`  ⚠ kolommen niet herkend: ${ontbrekend.join(", ")}`);
    alles.push(...r.stoffen);
  }

  // Samenvoegen met de bestaande lijst. Twee dingen mogen niet verloren gaan:
  // met zorg gekozen synoniemen, en stoffen die in deze import niet voorkomen.
  //
  // Dat laatste is geen theoretisch geval: importeer je alleen Annex II en III,
  // dan ontbreken de conserveermiddelen (V) en UV-filters (VI). Zonder deze
  // beveiliging zou een import de dekking stilzwijgend verkleinen — precies
  // het soort stille achteruitgang dat je in een compliance-tool niet merkt
  // tot een controle iets mist.
  // Samenvoegen gebeurt met de HUIDIGE lijst, niet met het uitvoerbestand.
  // Schreef je naar een ander pad (--out, of een --dry-run-controle), dan
  // vergeleek de vorige versie met een leeg of verouderd bestand en gingen de
  // handmatige synoniemen stilletjes verloren.
  const mergeBron = opt("--merge-with") || OUT_DEFAULT;
  let behouden = [];
  if (!heeft("--no-merge") && fs.existsSync(mergeBron)) {
    const oud = JSON.parse(fs.readFileSync(mergeBron, "utf8"));
    const nieuweNamen = new Set(alles.map((e) => e.inci.toLowerCase()));
    const oudeSyn = new Map(oud.filter((e) => e.synonyms).map((e) => [e.inci.toLowerCase(), e.synonyms]));

    let samengevoegd = 0;
    for (const stof of alles) {
      const bestaand = oudeSyn.get(stof.inci.toLowerCase());
      if (bestaand) {
        stof.synonyms = [...new Set([...(stof.synonyms || []), ...bestaand])];
        samengevoegd++;
      }
    }
    if (samengevoegd) console.log(`Bestaande synoniemen behouden voor ${samengevoegd} stoffen.`);

    behouden = oud.filter((e) => !nieuweNamen.has(e.inci.toLowerCase()));
    if (behouden.length) {
      if (heeft("--drop-missing")) {
        console.log(`\n⚠ ${behouden.length} stoffen uit de vorige lijst VERWIJDERD (--drop-missing):`);
        behouden.forEach((e) => console.log(`    - ${e.inci} (Annex ${e.annex})`));
        behouden = [];
      } else {
        console.log(`\n⚠ ${behouden.length} stoffen staan niet in deze import en zijn BEHOUDEN:`);
        behouden.forEach((e) => console.log(`    · ${e.inci} (Annex ${e.annex})`));
        console.log(`  Zitten ze in een annex die je nog niet hebt geïmporteerd (IV/V/VI)?`);
        console.log(`  Importeer die er dan bij. Weggooien kan met --drop-missing.`);
      }
    }
  }
  alles.push(...behouden);

  // Dubbele INCI-namen samenvoegen: dezelfde stof kan in meerdere annexen of
  // meerdere keren voorkomen. Annex II wint, want verboden gaat voor beperkt.
  const perNaam = new Map();
  for (const stof of alles) {
    const sleutel = stof.inci.toLowerCase();
    const bestaand = perNaam.get(sleutel);
    if (!bestaand || (bestaand.annex !== "II" && stof.annex === "II")) perNaam.set(sleutel, stof);
  }
  const eind = [...perNaam.values()];

  const perAnnex = {};
  eind.forEach((s) => { perAnnex[s.annex] = (perAnnex[s.annex] || 0) + 1; });

  console.log("");
  console.log(`Totaal: ${eind.length} unieke stoffen`, JSON.stringify(perAnnex));
  console.log(`Met CAS-nummer: ${eind.filter((s) => s.cas).length}`);
  console.log(`Met toelichting: ${eind.filter((s) => s.note).length}`);
  console.log("");
  console.log("Steekproef:");
  eind.slice(0, 3).forEach((s) => console.log("  " + JSON.stringify(s).slice(0, 160)));

  if (heeft("--dry-run")) {
    console.log("\n--dry-run: niets weggeschreven.");
    return;
  }

  fs.writeFileSync(uit, JSON.stringify(eind, null, 2) + "\n");
  console.log(`\n✅ Weggeschreven naar ${uit}`);
}

main().catch((e) => {
  console.error("\n❌ " + e.message);
  process.exit(1);
});
