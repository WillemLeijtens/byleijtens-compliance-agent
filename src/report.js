function buildMarkdownReport({ counts, violations, total, dateStr }) {
  const lines = [];
  lines.push(`# Compliance-scan — ${dateStr}`);
  lines.push("");
  lines.push(`EU Verordening (EG) 1223/2009 · Annex II & III · CosIng`);
  lines.push("");
  lines.push(`| Producten | Verboden (Annex II) | Beperkt (Annex III) | Zonder INCI | Conform |`);
  lines.push(`|---|---|---|---|---|`);
  lines.push(`| ${total} | ${counts.verboden} | ${counts.beperkt} | ${counts["geen-inci"]} | ${counts.ok} |`);
  lines.push("");

  if (!violations.length) {
    lines.push("Geen verboden of beperkte ingrediënten aangetroffen in deze scan.");
    return lines.join("\n");
  }

  lines.push(`## Bevindingen (${violations.length})`);
  lines.push("");
  violations
    .sort((a, b) => (a.status === "verboden" ? -1 : 1) - (b.status === "verboden" ? -1 : 1))
    .forEach((v) => {
      lines.push(`### ${v.status === "verboden" ? "🔴" : "🟠"} ${v.title} ${v.sku ? `(SKU ${v.sku})` : "(geen SKU)"}`);
      if (v.brand) lines.push(`Merk: ${v.brand}`);
      v.hits.forEach((h) => {
        lines.push(
          `- **${h.inci}**${h.cas ? ` · CAS ${h.cas}` : ""} · Annex ${h.annex} · ${h.ref}${h.note ? ` — ${h.note}` : ""} (match via ${h.via})`
        );
      });
      lines.push("");
    });

  return lines.join("\n");
}

module.exports = { buildMarkdownReport };
