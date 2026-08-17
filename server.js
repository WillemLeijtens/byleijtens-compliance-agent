const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const PORT = process.env.PORT || 3000;

/**
 * De expliciete allowlist van bestanden die deze server mag uitleveren.
 *
 * Hiervoor bouwde de statische handler het pad op met
 * path.join(__dirname, req.url). De documentroot was daarmee de héle
 * repository: /.env, /.git/config en server.js waren opvraagbaar door iedere
 * gebruiker die de app mocht openen, en ../-segmenten kwamen zelfs buiten de
 * repository uit. Alles wat het Node-proces kon lezen, kon het ook serveren.
 *
 * Waarom een allowlist en geen losse public/-map: de rapporten worden door de
 * workflow in reports/ gecommit en de assets staan waar het ontwerp ze
 * verwacht. Een allowlist geeft dezelfde garantie zonder die indeling om te
 * gooien, en is scherper — alleen wat de UI echt opvraagt gaat de deur uit.
 * Nieuwe bestanden zijn dus standaard onbereikbaar; dat is de bedoeling.
 */
const DOCROOT = __dirname;

const STATIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/dashboard.html", "dashboard.html"],
  ["/assets/logo-dark.svg", "assets/logo-dark.svg"],
  ["/assets/fonts/Montserrat-VariableFont_wght.ttf", "assets/fonts/Montserrat-VariableFont_wght.ttf"],
  ["/reports/violations-latest.json", "reports/violations-latest.json"]
]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf"
};

/**
 * Zet een binnenkomende URL om in een absoluut bestandspad, of geeft null
 * wanneer het verzoek niet in de allowlist staat.
 *
 * De containment-check onderaan is dubbelop zolang STATIC_FILES uitsluitend
 * hardgecodeerde relatieve paden bevat — en dat is precies de bedoeling: wie
 * er later een pad bij zet dat wél buiten de documentroot wijst, loopt tegen
 * deze grens aan in plaats van tegen een lek.
 */
function resolveStatic(rawUrl) {
  const zonderQuery = String(rawUrl || "").split(/[?#]/)[0];

  let pad;
  try {
    pad = decodeURIComponent(zonderQuery);
  } catch {
    return null; // kapotte percent-encoding, bijvoorbeeld /%zz
  }

  const doel = STATIC_FILES.get(pad);
  if (!doel) return null;

  // Dotfiles zijn nooit uit te leveren, ook niet als iemand ze per ongeluk
  // aan de allowlist toevoegt.
  if (doel.split("/").some((deel) => deel.startsWith("."))) return null;

  const absoluut = path.resolve(DOCROOT, doel);
  if (!absoluut.startsWith(DOCROOT + path.sep)) return null;

  return absoluut;
}

/**
 * GitHub-tokens bestaan uitsluitend uit [A-Za-z0-9_]. Copy-paste via een
 * mobiele/webterminal sleept er soms onzichtbare tekens in mee (zero-width
 * space, non-breaking space, CR), en die laten Node's http-client keihard
 * crashen met ERR_INVALID_CHAR zodra ze in de Authorization-header belanden.
 * trim() vangt dat niet af — een zero-width space telt daar niet als
 * whitespace. Strip daarom alles wat sowieso niet in een token thuishoort.
 */
function sanitizeToken(raw) {
  if (!raw) return "";
  return String(raw).replace(/[^A-Za-z0-9_]/g, "");
}

/**
 * De gateway (Traefik + authentik) verwijdert binnenkomende X-Authentik-*
 * headers vóórdat forward-auth draait en zet ze daarna zelf. Wat hier
 * binnenkomt is dus niet door de browser te vervalsen — mits het verzoek via
 * de gateway loopt. Komt er géén groepsheader binnen, dan is dit geen
 * gateway-verkeer en weigeren we: fail closed. Dat betekent ook dat de
 * Update-knop niet werkt als je de app rechtstreeks op poort 3000 opent, en
 * dat is precies de bedoeling.
 */
const ADMIN_GROUP = process.env.COMPLIANCE_ADMIN_GROUP || "app-compliance-admins";

function identiteit(req) {
  // authentik scheidt groepen met een pipe; sommige opstellingen met komma.
  const groepen = String(req.headers["x-authentik-groups"] || "")
    .split(/[|,]/)
    .map((g) => g.trim())
    .filter(Boolean);

  return {
    gebruiker: String(req.headers["x-authentik-username"] || "").trim() || "onbekend",
    groepen,
    isAdmin: groepen.includes(ADMIN_GROUP)
  };
}

/**
 * Weigert een state-changing POST die vanaf een andere site wordt afgevuurd.
 * Browsers sturen bij POST altijd een Origin mee, ook same-origin; ontbreekt
 * hij, dan komt het verzoek niet uit een browser (curl, de deploy-webhook) en
 * beschermt de groepscontrole hierboven.
 *
 * De vergelijking kijkt ook naar X-Forwarded-Host, omdat de gateway ertussen
 * zit: als die de Host-header ooit herschrijft, mag de knop daar niet stil op
 * stukloopen.
 */
function zelfdeOorsprong(req) {
  const origin = req.headers.origin;
  if (!origin) return true;

  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }

  return [process.env.PUBLIC_HOSTNAME, req.headers["x-forwarded-host"], req.headers.host]
    .filter(Boolean)
    .map((h) => String(h).split(",")[0].trim())
    .includes(host);
}

/**
 * Een handmatige workflow-start kost GitHub Actions-minuten en schrijft naar
 * de repository. Meer dan een paar per minuut is nooit legitiem.
 */
const TRIGGER_VENSTER_MS = 60_000;
const TRIGGER_MAX = 3;
const triggerHistorie = new Map();

function binnenTempolimiet(gebruiker) {
  const nu = Date.now();
  const recent = (triggerHistorie.get(gebruiker) || []).filter((t) => nu - t < TRIGGER_VENSTER_MS);
  if (recent.length >= TRIGGER_MAX) {
    triggerHistorie.set(gebruiker, recent);
    return false;
  }
  recent.push(nu);
  triggerHistorie.set(gebruiker, recent);
  return true;
}

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

/** Haalt de laatste workflow-run op en leidt daaruit de Shopify-koppelingsstatus
 * af (via de conclusie van de "Sync + scan + rapport"-stap). Gebruikt alleen
 * de GITHUB_TOKEN die de server al heeft — geen Shopify-secrets nodig op de
 * Droplet zelf, die staan alleen in GitHub Actions. */
async function getStatus() {
  const token = sanitizeToken(process.env.GITHUB_TOKEN);
  const repo = process.env.GITHUB_REPOSITORY || "WillemLeijtens/byleijtens-compliance-agent";
  const [owner, repoName] = repo.split("/");

  if (!token) {
    return { lastRun: null, shopify: { state: "onbekend", message: "GITHUB_TOKEN niet gezet op de server" } };
  }

  const runsRes = await githubApi(
    `/repos/${owner}/${repoName}/actions/workflows/monthly-compliance-check.yml/runs?per_page=1`,
    token
  );
  const run = runsRes.body?.workflow_runs?.[0];
  if (!run) {
    return { lastRun: null, shopify: { state: "onbekend", message: "Nog geen workflow-run gevonden" } };
  }

  const lastRun = {
    status: run.status,
    conclusion: run.conclusion,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    url: run.html_url
  };

  if (run.status !== "completed") {
    return { lastRun, shopify: { state: "onbekend", message: "Laatste run loopt nog" } };
  }

  // Zoek de "Sync + scan + rapport"-stap specifiek op, los van andere
  // stappen in dezelfde run.
  try {
    const jobsRes = await githubApi(`/repos/${owner}/${repoName}/actions/runs/${run.id}/jobs`, token);
    const job = jobsRes.body?.jobs?.[0];
    const step = job?.steps?.find((s) => s.name === "Sync + scan + rapport");
    if (step?.conclusion === "success") {
      return { lastRun, shopify: { state: "ok", message: "Shopify-koppeling werkt" } };
    }
    if (step?.conclusion === "failure") {
      return { lastRun, shopify: { state: "fout", message: "Sync mislukt — controleer SHOPIFY_*-secrets in GitHub" } };
    }
  } catch {
    // val terug op algemene run-conclusie hieronder
  }

  return {
    lastRun,
    shopify: {
      state: run.conclusion === "success" ? "ok" : "fout",
      message: run.conclusion === "success" ? "Shopify-koppeling werkt" : "Laatste run mislukt — check de Actions-log"
    }
  };
}

const server = http.createServer((req, res) => {
  // Geen Access-Control-Allow-Origin meer. Deze app heeft geen cross-origin
  // consument: het portaal linkt naar de eigen hostname en gebruikt geen
  // iframe. De wildcard zette /api/* onnodig open voor elke website.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("X-Frame-Options", "DENY");

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Allow": "GET, HEAD, POST, OPTIONS" });
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
    const wie = identiteit(req);

    if (!zelfdeOorsprong(req)) {
      console.warn(`[audit] workflow-start GEWEIGERD (vreemde oorsprong ${req.headers.origin}) door ${wie.gebruiker}`);
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Verzoek van een andere site geweigerd" }));
      return;
    }

    if (!wie.isAdmin) {
      console.warn(`[audit] workflow-start GEWEIGERD (geen ${ADMIN_GROUP}) door ${wie.gebruiker}`);
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: `Alleen leden van ${ADMIN_GROUP} mogen de scan starten. Rapporten bekijken mag wel.`
      }));
      return;
    }

    if (!binnenTempolimiet(wie.gebruiker)) {
      console.warn(`[audit] workflow-start GEWEIGERD (tempolimiet) door ${wie.gebruiker}`);
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Te vaak gestart — probeer het over een minuut opnieuw" }));
      return;
    }

    const token = sanitizeToken(process.env.GITHUB_TOKEN);
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

    // https.request() bouwt de headers synchroon op en gooit dus meteen als er
    // iets ongeldigs in zit. Zonder try/catch belandt die throw in de
    // 'request'-listener van de http-server, wat het hele proces omlegt (502
    // voor iedereen) in plaats van één mislukte knopdruk.
    try {
      const httpsReq = https.request(options, (httpsRes) => {
        let data = "";
        httpsRes.on("data", (chunk) => (data += chunk));
        httpsRes.on("end", () => {
          // GitHub's 204 (No Content) mag geen response body hebben — geef die
          // status door in de JSON-payload, niet als HTTP-statuscode, anders
          // gooit fetch()'s response.json() in de browser op een lege body.
          const outStatus = httpsRes.statusCode === 204 ? 200 : httpsRes.statusCode;
          console.log(
            `[audit] workflow-start door ${wie.gebruiker} — GitHub antwoordde ${httpsRes.statusCode}`
          );
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
    } catch (e) {
      console.error("Kon GitHub-request niet opbouwen:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Ongeldige GITHUB_TOKEN op de server (${e.code || e.message})` }));
    }
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

  // Statische bestanden — uitsluitend wat in STATIC_FILES staat.
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("405 Method Not Allowed");
    return;
  }

  const bestand = resolveStatic(req.url);
  if (!bestand) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 Not Found");
    return;
  }

  fs.readFile(bestand, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
      return;
    }

    const contentType = MIME_TYPES[path.extname(bestand)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  });
});

function toonStartbanner() {
  const rawToken = process.env.GITHUB_TOKEN || "";
  const cleanToken = sanitizeToken(rawToken);
  const stripped = rawToken.length - cleanToken.length;

  console.log(`\n📊 Compliance Dashboard: http://localhost:${PORT}`);
  if (!cleanToken) {
    console.log("GitHub Token: ❌ Niet gezet");
  } else {
    console.log(`GitHub Token: ✅ ${cleanToken.length} tekens, begint met "${cleanToken.slice(0, 11)}…"`);
    if (stripped > 0) {
      console.log(`  ⚠ ${stripped} ongeldig(e) teken(s) uit de token verwijderd (onzichtbare copy-paste-rommel).`);
    }
  }
  console.log(`Deploy webhook: ${process.env.DEPLOY_WEBHOOK_SECRET ? "✅ Ingeschakeld" : "❌ Uitgeschakeld (DEPLOY_WEBHOOK_SECRET niet gezet)"}`);
}

// Alleen luisteren wanneer dit bestand rechtstreeks wordt gestart. De tests
// requiren dezelfde server en kiezen zelf een vrije poort, zodat ze de echte
// request-afhandeling toetsen in plaats van een nagebouwde variant.
if (require.main === module) {
  server.listen(PORT, toonStartbanner);
}

module.exports = { server, resolveStatic, identiteit, zelfdeOorsprong, STATIC_FILES };
