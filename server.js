const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const { checkShopifyConnection } = require("./src/shopify-status");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // CORS headers voor API requests
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // API: Trigger workflow
  if (req.method === "POST" && req.url === "/api/trigger-workflow") {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY || "willemleijtens/byleijtens-compliance-agent";
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

    const httpsReq = require("https").request(options, (httpsRes) => {
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

  // API: Shopify-verbindingsstatus
  if (req.method === "GET" && req.url === "/api/shopify-status") {
    checkShopifyConnection().then((result) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    });
    return;
  }

  // Serve static files
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
  console.log(`\nGitHub Token: ${process.env.GITHUB_TOKEN ? "✅ Beschikbaar" : "❌ Niet gezet"}`);
});
