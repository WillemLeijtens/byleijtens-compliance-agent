const normalize = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[().,;:*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const CAS_RE = /\b\d{2,7}-\d{2}-\d\b/g;

function splitInci(raw) {
  if (!raw) return [];
  return raw
    .split(/[,;\u2022\n]+/)
    .map((x) => x.replace(/\[[^\]]*\]/g, "").trim())
    .filter(Boolean);
}

function buildIndex(list) {
  const byName = new Map();
  const byCas = new Map();
  list.forEach((e) => {
    if (e.inci) byName.set(normalize(e.inci), e);
    if (e.cas) String(e.cas).split(/[/\s]+/).forEach((c) => c && byCas.set(c.trim(), e));
  });
  return { byName, byCas };
}

function scanProduct(product, index) {
  const hits = [];
  splitInci(product.inci).forEach((tok) => {
    const n = normalize(tok);
    if (index.byName.has(n)) hits.push({ ingredient: tok, entry: index.byName.get(n), via: "INCI" });
  });
  const haystack = `${product.inci || ""} ${product.description || ""}`;
  (haystack.match(CAS_RE) || []).forEach((cas) => {
    if (index.byCas.has(cas)) {
      const e = index.byCas.get(cas);
      if (!hits.some((h) => h.entry === e)) hits.push({ ingredient: cas, entry: e, via: "CAS" });
    }
  });
  const banned = hits.filter((h) => h.entry.annex === "II");
  const restricted = hits.filter((h) => h.entry.annex !== "II");
  const status = banned.length ? "verboden" : restricted.length ? "beperkt" : product.inci ? "ok" : "geen-inci";
  return { status, banned, restricted };
}

function toDashboardEntry(r) {
  return {
    id: r.product.id,
    sku: r.product.sku,
    title: r.product.title,
    brand: r.product.brand,
    status: r.status,
    hits: [...r.banned, ...r.restricted].map((h) => ({
      inci: h.entry.inci,
      cas: h.entry.cas || null,
      annex: h.entry.annex,
      ref: h.entry.ref,
      note: h.entry.note || "",
      via: h.via,
    })),
  };
}

/** Scant de volledige productenlijst tegen de verboden/beperkte-stoffenlijst. */
function scanAll(products, prohibitedList) {
  const index = buildIndex(prohibitedList);
  const results = products.map((p) => ({ product: p, ...scanProduct(p, index) }));
  const counts = { verboden: 0, beperkt: 0, ok: 0, "geen-inci": 0 };
  results.forEach((r) => counts[r.status]++);
  const violations = results
    .filter((r) => r.status === "verboden" || r.status === "beperkt")
    .map(toDashboardEntry);
  // Alle producten (incl. conform/geen-inci) — voor dashboardfilters op elke categorie.
  const allProducts = results.map(toDashboardEntry);
  return { results, counts, violations, allProducts };
}

module.exports = { normalize, splitInci, buildIndex, scanProduct, scanAll };
