const test = require("node:test");
const assert = require("node:assert");
const { checkInciList, classifyEntry, buildIndex } = require("../src/compliance.js");
const lijst = require("../data/prohibited-list.json");

const oordeel = (inci) => checkInciList(inci, lijst).ingredients[0].status;

// De vijf annexen van Verordening (EG) 1223/2009 zijn niet hetzelfde soort
// lijst. II verbiedt, III beperkt, en IV/V/VI zijn juist TOEGESTAAN-lijsten:
// artikel 14 verbiedt alles wat daar NIET op staat. Deze test legt vast dat
// de app ze uit elkaar houdt.
test("Annex IV/V/VI zijn toelatingen, geen bevindingen", () => {
  assert.equal(oordeel("CI 10006"), "toegestaan", "Annex IV: toegelaten kleurstof");
  assert.equal(oordeel("Sodium Benzoate"), "toegestaan", "Annex V: toegelaten conserveermiddel");
  assert.equal(oordeel("Homosalate"), "toegestaan", "Annex VI: toegelaten UV-filter");
});

test("Annex II verbiedt absoluut waar geen uitzondering geldt", () => {
  for (const stof of ["Mercuric Chloride", "Thiourea", "Barium Chloride", "Dimethylamine", "3-Benzylidene Camphor"]) {
    assert.equal(oordeel(stof), "verboden", stof);
  }
});

// Lilial en Lyral zijn in 2021/2022 van Annex III naar Annex II verhuisd.
test("Verhuisde geurstoffen gelden als verboden, niet als beperkt", () => {
  assert.equal(oordeel("Butylphenyl Methylpropional"), "verboden");
  assert.equal(oordeel("Hydroxyisohexyl 3-Cyclohexene Carboxaldehyde"), "verboden");
});

// Een uitzondering die naar een ANDERE annex wijst noemt een aparte stof;
// het verbod op de stof die hier bij naam staat blijft dan gewoon gelden.
test("Uitzondering naar een andere annex heft het verbod niet op", () => {
  const index = buildIndex(lijst);
  const kwik = index.byName.get("mercury dichloride");
  assert.ok(kwik, "kwikchloride staat in de lijst");
  assert.equal(classifyEntry(kwik[0]), "verboden");
});

// Bij deze kleurstoffen geldt het verbod alleen in haarverf; als kleurstof
// staan ze gewoon in Annex IV. Dat is een controlepunt, geen verbod.
test("Verbod dat alleen op een producttype slaat wordt een controlepunt", () => {
  assert.equal(oordeel("CI 12490"), "beperkt");
  assert.equal(oordeel("CI 26100"), "beperkt");
});

// De ernstigste fout die deze test moet tegenhouden: CI 14270 staat in
// Annex II EN in Annex IV. Bewaart de index maar één regel per naam, dan
// bepaalt de importvolgorde welke wint en verdwijnt het verbod stilzwijgend.
test("Een naam in twee annexen levert het zwaarste oordeel", () => {
  const index = buildIndex(lijst);
  const treffers = index.byName.get("ci 14270");
  assert.ok(treffers.length > 1, "CI 14270 hoort meerdere regels te raken");
  assert.deepEqual(new Set(treffers.map((e) => e.annex)), new Set(["II", "IV"]));
  assert.notEqual(oordeel("CI 14270"), "toegestaan", "de Annex IV-regel mag het verbod niet maskeren");
});

// De geurallergenen uit Annex III kennen als enige voorwaarde een
// aangifteplicht. Staan ze in de INCI-lijst, dan is daaraan voldaan.
test("Geurallergenen met alleen een aangifteplicht zijn geen beperking", () => {
  assert.equal(oordeel("Amyl Cinnamal"), "etikettering");
  assert.equal(oordeel("Eugenol"), "etikettering");
  // Hydroxycitronellal heeft naast de aangifteplicht een echte grens (1,0 %).
  assert.equal(oordeel("Hydroxycitronellal"), "beperkt");
});

test("Annex III met een echte grens blijft beperkt", () => {
  assert.equal(oordeel("Talc"), "beperkt");
});

test("Onbekende stoffen leveren geen oordeel op", () => {
  assert.equal(oordeel("Aqua"), "ok");
});

// Generieke resten van botanische namen ("leaf", "stem oil") mochten nooit
// als synoniem in de index komen: die matchen op willekeurige etiketten.
test("Generieke naamfragmenten staan niet in de index", () => {
  const index = buildIndex(lijst);
  for (const rommel of ["leaf", "stem oil", "stem extract", "ec"]) {
    assert.equal(index.byName.has(rommel), false, rommel);
  }
});
