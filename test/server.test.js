/**
 * Regressietests voor de afscherming van de dashboard-server.
 *
 * De aanleiding is de audit van 17 augustus 2026: de statische handler bouwde
 * zijn pad met path.join(__dirname, req.url) en serveerde daarmee de hele
 * repository — /.env, /.git/config en server.js incluis. Deze tests leggen
 * vast dat dat dicht is en dicht blijft.
 *
 * Er draait een echte server op een vrije poort; we toetsen de daadwerkelijke
 * request-afhandeling, niet een nagebouwde variant ervan.
 */
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const { server } = require("../server.js");

let basis;

test.before(async () => {
  // Zonder token stopt /api/trigger-workflow met 400 vóór er ook maar één
  // verzoek naar GitHub gaat. De autorisatietests hieronder raken het netwerk
  // dus nooit.
  delete process.env.GITHUB_TOKEN;
  delete process.env.DEPLOY_WEBHOOK_SECRET;

  await new Promise((klaar) => server.listen(0, "127.0.0.1", klaar));
  basis = { host: "127.0.0.1", port: server.address().port };
});

test.after(() => new Promise((klaar) => server.close(klaar)));

/** Stuurt het pad ongewijzigd door — Node normaliseert de request-target niet,
 *  zodat ../-segmenten de server bereiken zoals een aanvaller ze zou sturen. */
function haal(pad, opties = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...basis, path: pad, method: opties.method || "GET", headers: opties.headers || {} },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on("error", reject);
    if (opties.body) req.write(opties.body);
    req.end();
  });
}

test("geheimen en repositorybestanden zijn niet op te vragen", async () => {
  const verboden = [
    "/.env",
    "/.git/config",
    "/.git/HEAD",
    "/server.js",
    "/package.json",
    "/src/config.js",
    "/set-github-token.sh",
    "/.gitignore"
  ];

  for (const pad of verboden) {
    const res = await haal(pad);
    assert.strictEqual(res.status, 404, `${pad} hoort 404 te geven, kreeg ${res.status}`);
    assert.doesNotMatch(res.body, /SHOPIFY|GITHUB_TOKEN|require\(/, `${pad} lekte inhoud`);
  }
});

test("padtraversal komt niet buiten de documentroot", async () => {
  const pogingen = [
    "/../../etc/passwd",
    "/../.env",
    "/reports/../.env",
    "/assets/../../etc/hostname",
    "/..%2f..%2fetc%2fpasswd",
    "/%2e%2e/%2e%2e/etc/passwd",
    "/%2e%65nv",
    "/.%65nv"
  ];

  for (const pad of pogingen) {
    const res = await haal(pad);
    assert.strictEqual(res.status, 404, `${pad} hoort 404 te geven, kreeg ${res.status}`);
  }
});

test("kapotte percent-encoding geeft 404 in plaats van een crash", async () => {
  const res = await haal("/%zz");
  assert.strictEqual(res.status, 404);
});

test("de allowlist levert wél uit wat de UI nodig heeft", async () => {
  const verwacht = [
    ["/", "text/html"],
    ["/index.html", "text/html"],
    ["/assets/logo-dark.svg", "image/svg+xml"],
    ["/reports/violations-latest.json", "application/json"]
  ];

  for (const [pad, type] of verwacht) {
    const res = await haal(pad);
    assert.strictEqual(res.status, 200, `${pad} hoort 200 te geven, kreeg ${res.status}`);
    assert.match(res.headers["content-type"], new RegExp(type.replace("+", "\\+")));
  }
});

test("elke reactie draagt de beveiligingsheaders", async () => {
  const res = await haal("/");
  assert.strictEqual(res.headers["x-content-type-options"], "nosniff");
  assert.match(res.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.strictEqual(res.headers["x-frame-options"], "DENY");
  assert.strictEqual(res.headers["access-control-allow-origin"], undefined);
});

test("workflow starten vereist de adminsgroep", async () => {
  const zonderHeaders = await haal("/api/trigger-workflow", { method: "POST" });
  assert.strictEqual(zonderHeaders.status, 403, "verkeer buiten de gateway om hoort te falen");

  const viewer = await haal("/api/trigger-workflow", {
    method: "POST",
    headers: { "x-authentik-username": "viewer", "x-authentik-groups": "app-compliance-users" }
  });
  assert.strictEqual(viewer.status, 403);
  assert.match(viewer.body, /beheerders/);
});

test("een admin komt langs de autorisatie heen", async () => {
  // Beide beheerdersgroepen geven toegang: platform-admins is het vinkje
  // "Beheerder" in het portaal, app-compliance-admins bestaat nog niet maar
  // moet werken zodra het platform hem aanmaakt.
  for (const groepen of [
    "app-compliance-users|app-compliance-admins",
    "app-compliance-users|platform-admins"
  ]) {
    const res = await haal("/api/trigger-workflow", {
      method: "POST",
      headers: { "x-authentik-username": "beheerder", "x-authentik-groups": groepen }
    });

    // 400 = "GITHUB_TOKEN niet gezet": de autorisatie is gepasseerd, en de
    // aanroep naar GitHub is nooit opgebouwd.
    assert.strictEqual(res.status, 400, `${groepen} hoort langs de autorisatie te komen`);
    assert.match(res.body, /GITHUB_TOKEN/);
  }
});

test("een POST vanaf een andere site wordt geweigerd", async () => {
  const res = await haal("/api/trigger-workflow", {
    method: "POST",
    headers: {
      "x-authentik-username": "beheerder",
      "x-authentik-groups": "app-compliance-admins",
      origin: "https://kwaadaardig.example"
    }
  });

  assert.strictEqual(res.status, 403);
  assert.match(res.body, /andere site/);
});

test("de eigen oorsprong wordt wel geaccepteerd", async () => {
  const res = await haal("/api/trigger-workflow", {
    method: "POST",
    headers: {
      "x-authentik-username": "beheerder",
      "x-authentik-groups": "app-compliance-admins",
      origin: "https://compliance.intern.beautyrockets.com",
      "x-forwarded-host": "compliance.intern.beautyrockets.com"
    }
  });

  assert.strictEqual(res.status, 400, "hoort door te lopen tot de tokencontrole");
});

test("statische bestanden nemen geen andere methodes aan", async () => {
  const res = await haal("/index.html", { method: "DELETE" });
  assert.strictEqual(res.status, 405);
});
