/**
 * Optioneel, los te draaien (bv. eens per kwartaal): controleert via de
 * Anthropic API of er nieuwe Annex II/III-wijzigingen zijn gepubliceerd
 * die nog niet in data/prohibited-list.json staan, en vult de lijst aan.
 *
 * Vereist een eigen ANTHROPIC_API_KEY (los van een Claude-abonnement,
 * betaald per gebruik — voor deze ene maandelijkse/kwartaal-call
 * verwaarloosbaar qua kosten).
 *
 * Gebruik:
 *   ANTHROPIC_API_KEY=sk-ant-xxxx node src/update-list.js
 */
const fs = require("fs");
const CONFIG = require("./config");

async function callClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CONFIG.anthropic.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });
  return res.json();
}

function extractJson(data) {
  const texts = (data?.content || []).filter((b) => b.type === "text").map((b) => b.text);
  for (let i = texts.length - 1; i >= 0; i--) {
    let clean = texts[i].trim();
    const fence = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) clean = fence[1].trim();
    const m = clean.match(/[\[{][\s\S]*[\]}]/);
    try { return JSON.parse(m ? m[0] : clean); } catch {}
  }
  return null;
}

async function main() {
  if (!CONFIG.anthropic.apiKey) {
    console.error("FOUT: zet ANTHROPIC_API_KEY als environment variable om dit script te draaien.");
    process.exit(1);
  }

  const list = JSON.parse(fs.readFileSync(CONFIG.paths.prohibitedListFile, "utf8"));
  const known = list.map((e) => e.inci).join("; ");
  const year = new Date().getFullYear();

  const prompt = `Search the web for the most recent amendments to Annex II and Annex III of EU Cosmetics Regulation (EC) 1223/2009 (Omnibus regulations, ${year - 1}-${year}), i.e. newly prohibited or newly restricted cosmetic ingredients in the EU.
I already track these INCI names: ${known}.
Respond with ONLY a JSON array of NEW entries not in my list (empty array if none), no markdown:
[{"inci":"INCI name","cas":"CAS number or empty","annex":"II or III","ref":"regulation number","note":"short note"}]`;

  console.log("Controleer op nieuwe Annex II/III-wijzigingen…");
  const data = await callClaude(prompt);
  if (data?.error) {
    console.error(`API-fout: ${data.error.message}`);
    process.exit(1);
  }

  const fresh = extractJson(data);
  if (!Array.isArray(fresh)) {
    console.error("Geen geldig JSON-resultaat ontvangen.");
    process.exit(1);
  }

  const existing = new Set(list.map((e) => e.inci.toLowerCase().trim()));
  const toAdd = fresh.filter((e) => e.inci && !existing.has(e.inci.toLowerCase().trim()));

  if (!toAdd.length) {
    console.log("Geen nieuwe stoffen gevonden — lijst is actueel.");
    return;
  }

  const merged = [...toAdd.map((e) => ({ ...e, annex: e.annex === "III" ? "III" : "II" })), ...list];
  fs.writeFileSync(CONFIG.paths.prohibitedListFile, JSON.stringify(merged, null, 2) + "\n");
  console.log(`${toAdd.length} nieuwe stof(fen) toegevoegd: ${toAdd.map((e) => e.inci).join(", ")}`);
  console.log("Vergeet niet deze wijziging te committen en te reviewen.");
}

main().catch((e) => {
  console.error("Onverwachte fout:", e);
  process.exit(1);
});
