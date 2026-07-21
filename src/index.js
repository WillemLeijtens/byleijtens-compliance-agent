const fs = require("fs");
const path = require("path");
const CONFIG = require("./config");
const { fetchAllProducts } = require("./shopify");
const { scanAll } = require("./compliance");
const { buildMarkdownReport } = require("./report");
const { openComplianceIssue } = require("./github-issue");

async function main() {
  console.log(`Start compliance-run — ${CONFIG.shopify.storeDomain}`);
  const started = Date.now();
  const dateStr = new Date().toISOString().slice(0, 10);

  const { products, errors, shopifyTotalCount } = await fetchAllProducts();

  const prohibitedList = JSON.parse(fs.readFileSync(CONFIG.paths.prohibitedListFile, "utf8"));
  const { counts, violations, allProducts } = scanAll(products, prohibitedList);

  fs.mkdirSync(CONFIG.paths.outputDir, { recursive: true });
  fs.writeFileSync(path.join(CONFIG.paths.outputDir, `products-${dateStr}.json`), JSON.stringify(products, null, 2));
  fs.writeFileSync(path.join(CONFIG.paths.outputDir, `violations-${dateStr}.json`), JSON.stringify(violations, null, 2));

  // Voor dashboard: latest violations + metadata + volledige productenlijst
  // (voor filters op "totaal"/"geen-inci") + storeDomain (voor Shopify-links)
  // + shopifyTotalCount (om sync-volledigheid te tonen zonder dat het
  // dashboard zelf Shopify-credentials nodig heeft).
  const dashboardData = {
    lastScan: new Date().toISOString(),
    counts: { ...counts, totaal: products.length },
    storeDomain: CONFIG.shopify.storeDomain,
    shopifyTotalCount,
    violations,
    allProducts
  };
  fs.writeFileSync(path.join(CONFIG.paths.outputDir, "violations-latest.json"), JSON.stringify(dashboardData, null, 2));

  const markdown = buildMarkdownReport({ counts, violations, total: products.length, dateStr });
  fs.writeFileSync(path.join(CONFIG.paths.outputDir, `report-${dateStr}.md`), markdown);
  fs.writeFileSync(path.join(CONFIG.paths.outputDir, "report-latest.md"), markdown);

  console.log(`\nKlaar in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`  ${products.length} producten gescand (Shopify telt ${shopifyTotalCount ?? "onbekend"})`);
  console.log(`  ${counts.verboden} verboden (Annex II), ${counts.beperkt} beperkt (Annex III), ${counts["geen-inci"]} zonder INCI`);

  if (violations.length && CONFIG.github.openIssueOnViolation) {
    try {
      await openComplianceIssue({
        token: CONFIG.github.token,
        repo: CONFIG.github.repo,
        markdownBody: markdown,
        violationCount: violations.length,
        dateStr,
      });
    } catch (e) {
      console.error(`  ⚠ GitHub issue aanmaken mislukt: ${e.message}`);
    }
  }

  if (errors.length) {
    fs.writeFileSync(path.join(CONFIG.paths.outputDir, `errors-${dateStr}.json`), JSON.stringify(errors, null, 2));
    console.warn(`  ⚠ ${errors.length} fout(en) tijdens Shopify-sync — checkpoint staat klaar, run opnieuw om te hervatten.`);
    process.exitCode = 1;
    return;
  }

  if (violations.length && CONFIG.failOnViolation) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("Onverwachte fout:", e);
  process.exit(1);
});
