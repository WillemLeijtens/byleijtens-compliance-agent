try { require("dotenv").config(); } catch {}

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`FOUT: environment variable ${name} ontbreekt.`);
    process.exit(1);
  }
  return v;
}

const CONFIG = {
  shopify: {
    storeDomain: required("SHOPIFY_STORE_DOMAIN"),
    accessToken: required("SHOPIFY_ADMIN_ACCESS_TOKEN"),
    // Shopify versioneert per kwartaal (YYYY-01/04/07/10) en ondersteunt een
    // versie ~1 jaar. Controleer periodiek de actuele stabiele versie op
    // https://shopify.dev/docs/api/admin-graphql en werk dit bij.
    apiVersion: process.env.SHOPIFY_API_VERSION || "2025-10",
    pageSize: Number(process.env.PAGE_SIZE || 50),
    maxRetries: 6,
  },
  github: {
    // In GitHub Actions automatisch beschikbaar — geen eigen secret nodig.
    token: process.env.GITHUB_TOKEN || "",
    repo: process.env.GITHUB_REPOSITORY || "", // "owner/naam"
    openIssueOnViolation: (process.env.OPEN_GITHUB_ISSUE || "true") === "true",
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
  },
  paths: {
    outputDir: process.env.OUTPUT_DIR || "reports",
    prohibitedListFile: process.env.PROHIBITED_LIST_FILE || "data/prohibited-list.json",
  },
  failOnViolation: (process.env.FAIL_ON_VIOLATION || "false") === "true",
  descriptionMaxLen: 400,
};

module.exports = CONFIG;
