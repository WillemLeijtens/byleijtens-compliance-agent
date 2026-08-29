const normalize = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[().,;:*]/g, " ")
    // Etiketten schrijven nummersuffixen wisselend: "Benzophenone-3",
    // "Benzophenone - 3", "Benzophenone 3". Trek dat naar \u00e9\u00e9n vorm.
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();

// Van zwaar naar licht. Bepaalt welke regel wint als een naam er meerdere
// raakt, en welk oordeel de status van een heel product zet.
const ERNST = { verboden: 0, beperkt: 1, toegestaan: 2 };

const CAS_RE = /\b\d{2,7}-\d{2}-\d\b/g;
// Kleurstoffen staan op etiketten meestal als CI-nummer, niet als INCI-naam.
const CI_RE = /\bci\s*\d{5}\b/gi;

function splitInci(raw) {
  if (!raw) return [];
  return raw
    .split(/[,;\u2022\n]+/)
    .map((x) => x.replace(/\[[^\]]*\]/g, "").trim())
    .filter(Boolean);
}

// Losse woorden die na het splitsen van een botanische naam overblijven
// ("Melissa officinalis leaf / stem oil" levert "leaf" en "stem oil" op).
// Als synoniem zijn ze waardeloos en gevaarlijk: ze matchen op elk etiket.
const GENERIEKE_DELEN = new Set(
  "leaf stem oil extract root bark seed flower fruit water juice powder wax butter ec".split(" ")
);
const CAS_VORM = /^\d{2,7}-\d{2}-\d$/;

function bruikbaarSynoniem(n) {
  if (!n || n.length < 2) return false;
  if (/^[\d\W_]+$/.test(n)) return false; // "29", "[1]", "--"
  return !n.split(" ").every((w) => GENERIEKE_DELEN.has(w));
}

function buildIndex(list) {
  const byName = new Map();
  const byCas = new Map();

  // Eén naam kan naar MEERDERE stoffen wijzen. CI 14270 staat bijvoorbeeld in
  // Annex IV (toegestaan als kleurstof) én in Annex II (verboden in haarverf).
  // Zou de index één entry per naam bewaren, dan bepaalt de importvolgorde
  // welke wint en kan een verbod stilletjes verdwijnen achter een toelating.
  const voegToe = (map, sleutel, entry) => {
    if (!sleutel) return;
    const bestaand = map.get(sleutel);
    if (bestaand) {
      if (!bestaand.includes(entry)) bestaand.push(entry);
    } else {
      map.set(sleutel, [entry]);
    }
  };

  list.forEach((e) => {
    voegToe(byName, normalize(e.inci), e);
    // Synoniemen en CI-nummers wijzen naar dezelfde stof. Zonder deze index
    // mist een etiket dat "Oxybenzone" of "CI 42555" schrijft de match, ook
    // al staat de stof gewoon in de lijst.
    (e.synonyms || []).forEach((syn) => {
      const n = normalize(syn);
      if (bruikbaarSynoniem(n)) voegToe(byName, n, e);
    });
    if (e.cas) {
      String(e.cas)
        .split(/[/\s]+/)
        .forEach((c) => {
          const nummer = c.trim();
          if (CAS_VORM.test(nummer)) voegToe(byCas, nummer, e);
        });
    }
  });
  return { byName, byCas };
}

/**
 * Zoekt \u00e9\u00e9n ingredi\u00ebnt op in de index en geeft { entry, via } terug, of null.
 *
 * Etiketten schrijven een stof zelden precies zoals de wetgeving hem noemt.
 * Daarom worden meerdere schrijfwijzen geprobeerd: de naam zelf, de naam
 * zonder toevoeging tussen haakjes ("Methylisothiazolinone (MI)"), en juist
 * wat t\u00fassen de haakjes staat ("Vitamin E (Tocopherol)"). Een CAS- of
 * CI-nummer in het ingredi\u00ebnt telt ook mee.
 *
 * Gedeeld door de automatische scan en de handmatige check, zodat beide
 * dezelfde stof altijd op dezelfde manier herkennen.
 */
function matchToken(token, index) {
  const kandidaten = [];

  const heel = normalize(token);
  if (heel) kandidaten.push(heel);

  const zonderHaakjes = normalize(String(token).replace(/\([^)]*\)/g, " "));
  if (zonderHaakjes && zonderHaakjes !== heel) kandidaten.push(zonderHaakjes);

  for (const m of String(token).matchAll(/\(([^)]*)\)/g)) {
    const binnen = normalize(m[1]);
    if (binnen) kandidaten.push(binnen);
  }

  for (const kandidaat of kandidaten) {
    const treffers = index.byName.get(kandidaat);
    if (treffers && treffers.length) return { entries: treffers, via: "INCI" };
  }

  const cas = (String(token).match(CAS_RE) || [])[0];
  if (cas && index.byCas.has(cas)) return { entries: index.byCas.get(cas), via: "CAS" };

  const ci = (String(token).match(CI_RE) || [])[0];
  if (ci) {
    const genormaliseerd = normalize(ci).replace(/\s+/g, " ");
    const treffers = index.byName.get(genormaliseerd);
    if (treffers && treffers.length) return { entries: treffers, via: "CI-nummer" };
  }

  return null;
}

/**
 * Kiest uit meerdere regels voor dezelfde naam de zwaarste.
 *
 * Staat een stof zowel op een verbodslijst als op een toegestaan-lijst, dan
 * telt het verbod. Anders zou een toelating een verbod kunnen maskeren.
 */
function zwaarste(entries) {
  return entries.reduce((a, b) => (ERNST[classifyEntry(b)] < ERNST[classifyEntry(a)] ? b : a));
}

/**
 * Bepaalt wat een treffer betekent volgens Verordening (EG) 1223/2009.
 *
 * De annexen zijn geen lijstjes van hetzelfde soort. II is een verbodslijst,
 * III een lijst met beperkingen, maar IV (kleurstoffen), V (conserveer-
 * middelen) en VI (UV-filters) zijn TOEGESTAAN-lijsten: artikel 14 verbiedt
 * juist alles wat er NIET op staat. Een treffer daar is dus geen bevinding —
 * het is de bevestiging dat de stof is toegelaten, met de voorwaarden die in
 * de annex staan (maximumconcentratie, producttype, waarschuwingen).
 */
// De voorwaarde bij een Annex II-regel staat lang niet altijd in de note.
// CosIng zet hem net zo vaak in de stofnaam zelf ("Furocoumarines … except
// for normal content in natural essences") of in een van de synoniemen
// ("… when used as a substance in hair dye products"). Alleen naar de note
// kijken verklaart zulke stoffen ten onrechte absoluut verboden.
const voorwaardeTekst = (entry) =>
  [entry.inci, entry.note, ...(entry.synonyms || [])].filter(Boolean).join(" ");

const UITZONDERING =
  /\b(except|unless|other than|with the exception|when used as)\b|\(nano\)|\bin hair dye products\b/i;

// Verwijst de uitzondering naar een ANDERE annex ("kwik en zijn verbindingen,
// behalve de gevallen in Annex V"), dan is die uitzondering een apart
// genoemde stof — niet degene die hier bij naam staat. Het verbod blijft dus
// staan. Verwijst hij naar een vorm of een producttype, dan is het een
// controlepunt: alleen de nanovorm, alleen in haarverf, alleen boven een
// natuurlijk gehalte.
const VERWIJST_NAAR_ANNEX = /\bannex\s+(iii|iv|v|vi)\b/i;

// De officiële kopjes uit Verordening (EG) 1223/2009. Ze staan hier zodat de
// scan, het markdown-rapport en de interface dezelfde tekst tonen.
const ANNEX_TITELS = {
  II: "List of substances prohibited in cosmetic products",
  III:
    "List of substances which cosmetic products must not contain except subject to " +
    "the restrictions laid down",
  IV: "List of colorants allowed in cosmetic products",
  V: "List of preservatives allowed in cosmetic products",
  VI: "List of UV filters allowed in cosmetic products",
};

const SOORT_CACHE = new WeakMap();

function classifyEntry(entry) {
  const onthouden = SOORT_CACHE.get(entry);
  if (onthouden) return onthouden;

  let soort;
  if (entry.annex === "II") {
    const tekst = voorwaardeTekst(entry);
    const voorwaardelijk = entry.conditional || UITZONDERING.test(tekst);
    soort = voorwaardelijk && !VERWIJST_NAAR_ANNEX.test(tekst) ? "beperkt" : "verboden";
  } else if (entry.annex === "III") {
    soort = "beperkt";
  } else {
    soort = "toegestaan";
  }

  SOORT_CACHE.set(entry, soort);
  return soort;
}

function scanProduct(product, index) {
  const hits = [];
  const noteerTreffer = (ingredient, entries, via) => {
    const entry = zwaarste(entries);
    if (hits.some((h) => h.entry === entry && h.ingredient === ingredient)) return;
    hits.push({
      ingredient,
      entry,
      via,
      // Andere annexen waarin dezelfde naam voorkomt; zichtbaar houden zodat
      // een analist ziet dat de stof ook ergens toegelaten is.
      ookIn: entries.filter((e) => e !== entry).map((e) => e.annex),
    });
  };

  splitInci(product.inci).forEach((tok) => {
    const treffer = matchToken(tok, index);
    if (treffer) noteerTreffer(tok, treffer.entries, treffer.via);
  });
  const haystack = `${product.inci || ""} ${product.description || ""}`;
  (haystack.match(CAS_RE) || []).forEach((cas) => {
    const entries = index.byCas.get(cas);
    if (!entries) return;
    const entry = zwaarste(entries);
    if (!hits.some((h) => h.entry === entry)) noteerTreffer(cas, entries, "CAS");
  });

  const banned = hits.filter((h) => classifyEntry(h.entry) === "verboden");
  const restricted = hits.filter((h) => classifyEntry(h.entry) === "beperkt");
  // Annex IV, V en VI zijn toelatingslijsten. Een treffer daar melden zet een
  // product ten onrechte in een kwaad daglicht, dus die verdwijnen hier.
  const status = banned.length || restricted.length ? "verboden" : product.inci ? "ok" : "geen-inci";
  return { status, banned, restricted };
}

function toDashboardEntry(r) {
  return {
    id: r.product.id,
    sku: r.product.sku,
    title: r.product.title,
    brand: r.product.brand,
    image: r.product.image || null,
    status: r.status,
    // Elke treffer draagt zijn eigen oordeel: een product met een verboden
    // stof kan daarnaast een keurig toegelaten kleurstof bevatten, en die
    // twee horen niet als hetzelfde te worden getoond.
    hits: [...r.banned, ...r.restricted].map((h) => ({
      inci: h.entry.inci,
      cas: h.entry.cas || null,
      annex: h.entry.annex,
      ref: h.entry.ref,
      note: h.entry.note || "",
      via: h.via,
      soort: classifyEntry(h.entry),
      annexTitel: ANNEX_TITELS[h.entry.annex] || "",
      ookIn: h.ookIn && h.ookIn.length ? h.ookIn : null,
    })),
  };
}

/** Scant de volledige productenlijst tegen de verboden/beperkte-stoffenlijst. */
function scanAll(products, prohibitedList) {
  const index = buildIndex(prohibitedList);
  const results = products.map((p) => ({ product: p, ...scanProduct(p, index) }));
  const counts = { verboden: 0, ok: 0, "geen-inci": 0 };
  results.forEach((r) => counts[r.status]++);
  const violations = results
    .filter((r) => r.status === "verboden")
    .map(toDashboardEntry);
  // Alle producten (incl. conform/geen-inci) — voor dashboardfilters op elke categorie.
  const allProducts = results.map(toDashboardEntry);
  return { results, counts, violations, allProducts };
}

/**
 * Controleert een losse, geplakte INCI-lijst ingrediënt voor ingrediënt.
 *
 * Anders dan scanProduct, dat één status per product teruggeeft, levert dit
 * per ingrediënt een oordeel — dat is wat een handmatige controle nodig heeft.
 * Gebruikt bewust dezelfde normalisatie, splitsing en index als de
 * automatische scan, zodat een handmatige check en de Shopify-scan nooit
 * tegenstrijdige uitkomsten kunnen geven voor hetzelfde ingrediënt.
 */
function checkInciList(rawInci, prohibitedList) {
  const index = buildIndex(prohibitedList);

  const ingredients = splitInci(rawInci).map((token) => {
    const treffer = matchToken(token, index);
    const entry = treffer ? zwaarste(treffer.entries) : null;
    const via = treffer ? treffer.via : null;

    const soort = entry ? classifyEntry(entry) : null;
    // Annex IV/V/VI blijft zichtbaar als herkenning, maar zonder oordeel.
    const status = soort === "verboden" || soort === "beperkt" ? soort : "ok";

    return {
      input: token,
      status,
      match: entry
        ? {
            inci: entry.inci,
            cas: entry.cas || null,
            annex: entry.annex,
            annexTitel: ANNEX_TITELS[entry.annex] || "",
            ref: entry.ref,
            note: entry.note || "",
            via,
          }
        : null,
    };
  });

  const counts = { verboden: 0, beperkt: 0, ok: 0 };
  ingredients.forEach((i) => counts[i.status]++);

  return {
    ingredients,
    counts,
    totaal: ingredients.length,
    // Het zwaarste oordeel bepaalt de status van het geheel.
    status: counts.verboden ? "verboden" : counts.beperkt ? "beperkt" : ingredients.length ? "ok" : "leeg",
  };
}

/**
 * Vingerafdruk van de stoffenlijst: aantal + korte hash van de inhoud.
 *
 * De Shopify-scan draait in GitHub Actions en de handmatige check op de
 * Droplet. Beide lezen data/prohibited-list.json, maar uit een eigen kopie van
 * de repository. Wordt daar één van bijgewerkt zonder de ander, dan geven
 * dezelfde ingrediënten stilletjes verschillende uitkomsten — precies het soort
 * verschil dat je pas merkt als een controle iets mist.
 *
 * De scan schrijft zijn vingerafdruk in het rapport en de server rapporteert de
 * zijne, zodat het dashboard kan laten zien of beide kanten dezelfde lijst
 * gebruiken.
 */
function listFingerprint(list) {
  // Ook de synoniemen tellen mee. Zij bepalen wat de app herkent: valt er een
  // synoniem weg, dan verandert de uitslag terwijl namen, annexen en
  // CAS-nummers gelijk blijven. Een vingerafdruk die dat niet ziet, bewijst
  // niet wat hij hoort te bewijzen.
  const genormaliseerd = (list || [])
    .map((e) => `${e.inci}|${e.annex}|${e.cas || ""}|${(e.synonyms || []).slice().sort().join("~")}`)
    .sort()
    .join("\n");

  // Kleine, stabiele hash (FNV-1a) — geen crypto nodig, alleen gelijkheid.
  let hash = 0x811c9dc5;
  for (let i = 0; i < genormaliseerd.length; i++) {
    hash ^= genormaliseerd.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return { count: (list || []).length, hash: hash.toString(16).padStart(8, "0") };
}

module.exports = {
  normalize,
  splitInci,
  buildIndex,
  classifyEntry,
  scanProduct,
  scanAll,
  checkInciList,
  listFingerprint,
  ANNEX_TITELS,
};
