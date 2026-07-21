const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { checkShopifyConnection } = require("./src/shopify-status");

const PORT = process.env.PORT || 3000;

function githubApi(apiPath, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      port: 443,
      path: apiPath,
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "Compliance-Dashboard"
      }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Haalt de laatste workflow-run op (tijdstip + status/conclusie). De
 * Shopify-koppelingsstatus zelf komt uit /api/shopify-status hieronder (live
 * check), dit endpoint gaat alleen over de laatste geplande/handmatige run. */
async function getStatus() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY || "WillemLeijtens/byleijtens-compliance-agent";
  const [owner, repoName] = repo.split("/");

  if (!token) {
    return { lastRun: null };
  }

  const runsRes = await githubApi(
    `/repos/${owner}/${repoName}/actions/workflows/monthly-compliance-check.yml/runs?per_page=1`,
    token
  );
  const run = runsRes.body?.workflow_runs?.[0];
  if (!run) {
    return { lastRun: null };
  }

  return {
    lastRun: {
      status: run.status,
      conclusion: run.conclusion,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      url: run.html_url
    }
  };
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Webhook-Secret");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // API: laatste run + Shopify-koppelingsstatus
  if (req.method === "GET" && req.url === "/api/status") {
    getStatus()
      .then((result) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      })
      .catch((e) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
    return;
  }

  // API: workflow handmatig starten
  if (req.method === "POST" && req.url === "/api/trigger-workflow") {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY || "WillemLeijtens/byleijtens-compliance-agent";
    const [owner, repoName] = repo.split("/");

    if (!token) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "GITHUB_TOKEN niet gezet" }));
      return;
    }

    const options = {
      hostname: "api.github.com",
      port: 443,
      path: `/repos/${owner}/${repoName}/actions/workflows/monthly-compliance-check.yml/dispatches`,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "Compliance-Dashboard"
      }
    };

    const httpsReq = https.request(options, (httpsRes) => {
      let data = "";
      httpsRes.on("data", (chunk) => (data += chunk));
      httpsRes.on("end", () => {
        // GitHub's 204 (No Content) mag geen response body hebben — geef die
        // status door in de JSON-payload, niet als HTTP-statuscode, anders
        // gooit fetch()'s response.json() in de browser op een lege body.
        const outStatus = httpsRes.statusCode === 204 ? 200 : httpsRes.statusCode;
        res.writeHead(outStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: httpsRes.statusCode, message: httpsRes.statusCode === 204 ? "Workflow gestart!" : data }));
      });
    });

    httpsReq.on("error", (e) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    });

    httpsReq.write(JSON.stringify({ ref: "main" }));
    httpsReq.end();
    return;
  }

  // API: webhook die GitHub Actions na een succesvolle run aanroept om de
  // server bij te werken (git pull + herstart), zonder handmatige tussenstap.
  if (req.method === "POST" && req.url === "/api/webhook-deploy") {
    const secret = process.env.DEPLOY_WEBHOOK_SECRET;
    if (!secret) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Webhook niet geconfigureerd" }));
      return;
    }
    if (req.headers["x-webhook-secret"] !== secret) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Ongeldig webhook secret" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", message: "Herdeploy gestart" }));

    exec(
      `cd ${__dirname} && git pull origin main && npm install --omit=dev && pm2 restart compliance-agent`,
      (err, stdout, stderr) => {
        if (err) console.error("Webhook-deploy mislukt:", err.message, stderr);
        else console.log("Webhook-deploy geslaagd:\n", stdout);
      }
    );
    return;
  }

  // API: Shopify-verbindingsstatus (live check)
  if (req.method === "GET" && req.url === "/api/shopify-status") {
    checkShopifyConnection().then((result) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    });
    return;
  }

  // Statische bestanden
  let filePath = req.url === "/" ? "/index.html" : req.url;
  filePath = path.join(__dirname, filePath);

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
      return;
    }

    const ext = path.extname(filePath);
    const mimeTypes = {
      ".html": "text/html",
      ".json": "application/json",
      ".js": "application/javascript",
      ".css": "text/css"
    };
    const contentType = mimeTypes[ext] || "text/plain";

    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`\n📊 Compliance Dashboard: http://localhost:${PORT}`);
  console.log(`GitHub Token: ${process.env.GITHUB_TOKEN ? "✅ Beschikbaar" : "❌ Niet gezet"}`);
  console.log(`Deploy webhook: ${process.env.DEPLOY_WEBHOOK_SECRET ? "✅ Ingeschakeld" : "❌ Uitgeschakeld (DEPLOY_WEBHOOK_SECRET niet gezet)"}`);
});
