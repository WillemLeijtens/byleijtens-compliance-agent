const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const zlib = require("zlib");
const { checkInciList, listFingerprint } = require("./src/compliance");

const PORT = process.env.PORT || 3000;

const PROHIBITED_LIST_FILE = path.join(__dirname, "data", "prohibited-list.json");
// Handmatige checks staan bewust los van reports/ (de Shopify-scan) en buiten
// git — anders zou de git pull van de deploy-webhook stukloopt op lokaal
// gewijzigde data.
const MANUAL_CHECKS_FILE = path.join(__dirname, "data", "manual-checks.json");

/**
 * De stoffenlijst wordt bij elke check gelezen. Met de volledige annexen erin
 * is dat een bestand van formaat, dus cachen we het en verversen alleen als de
 * mtime verandert — een geïmporteerde lijst is dan meteen actief, zonder
 * herstart en zonder elke aanvraag opnieuw te parsen.
 */
let prohibitedCache = { mtimeMs: 0, lijst: null };

function readProhibitedList() {
  const { mtimeMs } = fs.statSync(PROHIBITED_LIST_FILE);
  if (prohibitedCache.lijst && prohibitedCache.mtimeMs === mtimeMs) {
    return prohibitedCache.lijst;
  }
  const lijst = JSON.parse(fs.readFileSync(PROHIBITED_LIST_FILE, "utf8"));
  prohibitedCache = { mtimeMs, lijst };
  return lijst;
}

function readManualChecks() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MANUAL_CHECKS_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // bestand bestaat nog niet of is leeg
  }
}

function writeManualChecks(checks) {
  fs.mkdirSync(path.dirname(MANUAL_CHECKS_FILE), { recursive: true });
  // Eerst naar een tijdelijk bestand, dan hernoemen: een onderbroken schrijf
  // laat zo nooit een half bestand achter.
  const tmp = `${MANUAL_CHECKS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(checks, null, 2));
  fs.renameSync(tmp, MANUAL_CHECKS_FILE);
}

/** Leest een JSON-body, met een limiet zodat een grote POST het geheugen niet opvreet. */
function readJsonBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Verzoek te groot"));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Ongeldige JSON in verzoek"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/**
 * Het adres waarop de server luistert. Standaard alleen loopback.
 *
 * Hiervoor gaf server.listen() geen adres mee, waardoor Node aan álle
 * interfaces bond — inclusief het publieke adres van de Droplet. De app stond
 * daarmee op het open internet te luisteren en alleen de cloudfirewall hield
 * bezoek tegen; één verkeerde regel daar en de app lag open.
 *
 * In productie hoort HOST het privé (VPC) adres te zijn, zodat uitsluitend de
 * gateway erbij kan. Vergeet je HOST te zetten, dan is de app onbereikbaar in
 * plaats van publiek bereikbaar: dat is de goede kant om te falen.
 */
const HOST = process.env.HOST || "127.0.0.1";

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

// Alleen tekstformaten hebben baat bij compressie; fonts en SVG-plaatjes
// nauwelijks, en onder een kilobyte kost het meer dan het oplevert.
const GZIP_TYPES = new Set([".html", ".json", ".js", ".css", ".svg"]);
const GZIP_DREMPEL = 1024;

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
/**
 * Wie de scan mag starten. Twee namen, want het platform maakt per app alleen
 * de users-groep aan; het admin_group-veld uit het register belandt nooit in
 * de identityprovider. app-compliance-admins bestaat dus niet, en een controle
 * die alleen daarnaar keek sloot iedereen buiten — ook de beheerder.
 *
 * platform-admins is de groep achter het vinkje "Beheerder" in het portaal en
 * bestaat wél. app-compliance-admins blijft erbij staan zodat de controle
 * vanzelf fijnmaziger wordt zodra het platform die groep wél aanmaakt.
 */
const ADMIN_GROUPS = String(
  process.env.COMPLIANCE_ADMIN_GROUPS || "app-compliance-admins,platform-admins"
)
  .split(",")
  .map((g) => g.trim())
  .filter(Boolean);

function identiteit(req) {
  // authentik scheidt groepen met een pipe; sommige opstellingen met komma.
  const groepen = String(req.headers["x-authentik-groups"] || "")
    .split(/[|,]/)
    .map((g) => g.trim())
    .filter(Boolean);

  return {
    gebruiker: String(req.headers["x-authentik-username"] || "").trim() || "onbekend",
    groepen,
    isAdmin: groepen.some((g) => ADMIN_GROUPS.includes(g))
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

/**
 * Opslaan is goedkoop maar schrijft naar schijf, dus ruimer begrensd dan de
 * scanstart. Het harde plafond hieronder voorkomt dat het bestand ongemerkt
 * blijft groeien.
 */
const OPSLAG_VENSTER_MS = 60_000;
const OPSLAG_MAX = 20;
const MAX_BEWAARDE_CHECKS = 500;
const opslagHistorie = new Map();

function binnenOpslaglimiet(gebruiker) {
  const nu = Date.now();
  const recent = (opslagHistorie.get(gebruiker) || []).filter((t) => nu - t < OPSLAG_VENSTER_MS);
  if (recent.length >= OPSLAG_MAX) {
    opslagHistorie.set(gebruiker, recent);
    return false;
  }
  recent.push(nu);
  opslagHistorie.set(gebruiker, recent);
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
      console.warn(`[audit] workflow-start GEWEIGERD (geen ${ADMIN_GROUPS.join(" of ")}) door ${wie.gebruiker}`);
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: `Alleen beheerders mogen de scan starten (${ADMIN_GROUPS.join(" of ")}). Rapporten bekijken mag wel.`
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

  // ---- Handmatige INCI-check --------------------------------------------
  // Staat los van de Shopify-scan: eigen endpoints, eigen opslagbestand.
  // Iedereen die door de gateway komt mag checken en opslaan; dat is werk,
  // geen beheer. De oorsprongscontrole geldt wel, net als bij de scanstart.

  if (req.method === "POST" && req.url === "/api/inci-check") {
    if (!zelfdeOorsprong(req)) {
      return sendJson(res, 403, { error: "Verzoek van een andere site geweigerd" });
    }
    readJsonBody(req)
      .then((body) => {
        const inci = typeof body.inci === "string" ? body.inci : "";
        if (!inci.trim()) return sendJson(res, 400, { error: "Plak eerst een INCI-lijst" });
        const lijst = readProhibitedList();
        const resultaat = checkInciList(inci, lijst);
        const vinger = listFingerprint(lijst);
        // listSize maakt in de UI expliciet hoe breed de controle reikt.
        sendJson(res, 200, { productName: String(body.productName || ""), inci, listSize: lijst.length, prohibitedList: vinger, ...resultaat });
      })
      .catch((e) => sendJson(res, 400, { error: e.message }));
    return;
  }

  if (req.method === "GET" && req.url === "/api/manual-checks") {
    try {
      sendJson(res, 200, { checks: readManualChecks() });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/manual-checks") {
    const wie = identiteit(req);

    if (!zelfdeOorsprong(req)) {
      console.warn(`[audit] check opslaan GEWEIGERD (vreemde oorsprong) door ${wie.gebruiker}`);
      return sendJson(res, 403, { error: "Verzoek van een andere site geweigerd" });
    }
    if (!binnenOpslaglimiet(wie.gebruiker)) {
      return sendJson(res, 429, { error: "Te veel opgeslagen in korte tijd — probeer het zo opnieuw" });
    }

    readJsonBody(req)
      .then((body) => {
        const inci = typeof body.inci === "string" ? body.inci : "";
        if (!inci.trim()) return sendJson(res, 400, { error: "Plak eerst een INCI-lijst" });

        const checks = readManualChecks();
        if (checks.length >= MAX_BEWAARDE_CHECKS) {
          return sendJson(res, 409, {
            error: `Maximum van ${MAX_BEWAARDE_CHECKS} opgeslagen checks bereikt — verwijder er eerst een paar.`
          });
        }

        // Opnieuw berekenen in plaats van de uitslag uit de body overnemen:
        // wat je opslaat klopt zo gegarandeerd met de huidige stoffenlijst,
        // en de client kan geen verzonnen oordeel laten bewaren.
        const resultaat = checkInciList(inci, readProhibitedList());
        const entry = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          productName: String(body.productName || "").trim() || "Naamloos product",
          inci,
          savedAt: new Date().toISOString(),
          savedBy: wie.gebruiker,
          ...resultaat
        };

        checks.unshift(entry); // nieuwste bovenaan
        writeManualChecks(checks);
        console.log(`[audit] check opgeslagen "${entry.productName}" (${entry.status}) door ${wie.gebruiker}`);
        sendJson(res, 200, { saved: entry, total: checks.length });
      })
      .catch((e) => sendJson(res, 400, { error: e.message }));
    return;
  }

  if (req.method === "DELETE" && req.url.startsWith("/api/manual-checks")) {
    const wie = identiteit(req);

    if (!zelfdeOorsprong(req)) {
      console.warn(`[audit] check verwijderen GEWEIGERD (vreemde oorsprong) door ${wie.gebruiker}`);
      return sendJson(res, 403, { error: "Verzoek van een andere site geweigerd" });
    }

    try {
      const id = new URL(req.url, `http://${req.headers.host || "localhost"}`).searchParams.get("id");
      if (!id) return sendJson(res, 400, { error: "Geen id meegegeven" });

      const checks = readManualChecks();
      const resterend = checks.filter((c) => c.id !== id);
      if (resterend.length === checks.length) {
        return sendJson(res, 404, { error: "Check niet gevonden" });
      }
      writeManualChecks(resterend);
      console.log(`[audit] check verwijderd ${id} door ${wie.gebruiker}`);
      sendJson(res, 200, { deleted: id, total: resterend.length });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
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

    // Het rapport is met de volledige annexen flink gegroeid — ruim 12 MB,
    // en de browser haalt het op bij elke paginalading én elke vijf minuten.
    // Over een mobiele verbinding is dat niet acceptabel. Deze JSON is sterk
    // repetitief (31.000 treffers naar 199 unieke stoffen), dus gzip haalt er
    // ongeveer een factor zeventien af.
    const wilGzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
    if (wilGzip && GZIP_TYPES.has(path.extname(bestand)) && content.length > GZIP_DREMPEL) {
      zlib.gzip(content, (gzErr, gezipt) => {
        if (gzErr) {
          res.writeHead(200, { "Content-Type": contentType });
          res.end(content);
          return;
        }
        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Encoding": "gzip",
          "Vary": "Accept-Encoding"
        });
        res.end(gezipt);
      });
      return;
    }

    res.writeHead(200, { "Content-Type": contentType, "Vary": "Accept-Encoding" });
    res.end(content);
  });
});

function toonStartbanner() {
  const rawToken = process.env.GITHUB_TOKEN || "";
  const cleanToken = sanitizeToken(rawToken);
  const stripped = rawToken.length - cleanToken.length;

  console.log(`\n📊 Compliance Dashboard: http://${HOST}:${PORT}`);
  if (HOST === "0.0.0.0" || HOST === "::") {
    console.log("  ⚠ Luistert op ALLE interfaces, dus ook op het publieke adres.");
    console.log("    Zet HOST op het privé (VPC) adres zodat alleen de gateway erbij kan.");
  }
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
  server.listen(PORT, HOST, toonStartbanner);
}

module.exports = { server, resolveStatic, identiteit, zelfdeOorsprong, STATIC_FILES };
