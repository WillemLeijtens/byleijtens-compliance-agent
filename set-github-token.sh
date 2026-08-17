#!/bin/bash
# Zet/ververst de GitHub-token waarmee de "Update"-knop in het dashboard de
# compliance-workflow op afstand start. Werkt vanuit elke map.
#
# Valideert de token eerst tegen de GitHub API en raakt de draaiende app
# alleen aan als die test slaagt — een vervormde plak-actie kan de werkende
# situatie dus niet meer stukmaken.
#
# Gebruik (als root op de Droplet):
#   curl -sSL https://raw.githubusercontent.com/WillemLeijtens/byleijtens-compliance-agent/main/set-github-token.sh | bash -s -- "github_pat_xxxxx"

set -e

REPO="WillemLeijtens/byleijtens-compliance-agent"
APP_DIR=/apps/byleijtens-compliance-agent

# GitHub-tokens bestaan uitsluitend uit [A-Za-z0-9_]. Alles daarbuiten is
# plak-schade (spaties, newlines, of de bolletjes van een gemaskeerde
# weergave die per ongeluk is gekopieerd).
RAW="$1"
TOKEN=$(printf '%s' "$RAW" | tr -cd 'A-Za-z0-9_')

if [ -z "$TOKEN" ]; then
  echo "❌ Geen token meegegeven."
  echo "   Gebruik: ... | bash -s -- \"github_pat_xxxxx\""
  exit 1
fi

echo "Ontvangen: ${#RAW} tekens → na opschonen: ${#TOKEN} tekens"

# Een fine-grained token (github_pat_) is ~93 tekens, een classic token
# (ghp_) 40. Alles wat daar ver onder zit is vrijwel zeker vervormd.
if [ ${#TOKEN} -lt 30 ]; then
  echo ""
  echo "❌ Deze token is te kort (${#TOKEN} tekens) en dus vervormd bij het plakken."
  echo "   Begin: \"${TOKEN}\""
  echo ""
  echo "   Veelgemaakte fout: een GEMASKEERDE weergave gekopieerd (github_p••••••)."
  echo "   Kopieer de token rechtstreeks van de GitHub-pagina waar hij is aangemaakt."
  echo ""
  echo "   De app is NIET aangepast en blijft draaien zoals hij was."
  exit 1
fi

# Testen vóór we iets veranderen: kan deze token de workflow-runs lezen?
echo "Token testen tegen de GitHub API…"
HTTP=$(curl -s -o /tmp/.tokentest -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  -H "User-Agent: Compliance-Dashboard" \
  --max-time 20 \
  "https://api.github.com/repos/$REPO/actions/workflows/monthly-compliance-check.yml/runs?per_page=1" || echo "000")

if [ "$HTTP" != "200" ]; then
  echo ""
  echo "❌ GitHub weigert deze token (HTTP $HTTP)."
  head -c 300 /tmp/.tokentest 2>/dev/null; echo ""
  echo ""
  case "$HTTP" in
    401) echo "   401 = token ongeldig, verlopen of ingetrokken. Maak een nieuwe aan." ;;
    403) echo "   403 = token mist rechten. Nodig: repo-toegang tot $REPO + 'Actions: Read and write'." ;;
    404) echo "   404 = token ziet deze repo niet. Kies bij 'Repository access' expliciet $REPO." ;;
    000) echo "   Geen verbinding met api.github.com — netwerk/firewall op de server?" ;;
  esac
  echo ""
  echo "   De app is NIET aangepast en blijft draaien zoals hij was."
  rm -f /tmp/.tokentest
  exit 1
fi
rm -f /tmp/.tokentest

echo "✅ Token werkt."

cd "$APP_DIR"

# pm2 neemt de omgeving over van het moment van 'start'; een latere 'restart'
# ziet nieuwe variabelen niet. Daarom hier delete + start, met HOST erbij.
#
# HOST bepaalt waaraan de server bindt. Zonder waarde is dat loopback, en dan
# kan de gateway er niet bij — zet hem op het privé (VPC) adres van deze
# Droplet. Aan alle interfaces binden hoort niet: dan luistert de app ook op
# het publieke adres en is de cloudfirewall het enige dat bezoek tegenhoudt.
BIND_HOST="${HOST:-127.0.0.1}"
echo "   Bindadres: $BIND_HOST"

pm2 delete compliance-agent 2>/dev/null || true
HOST="$BIND_HOST" GITHUB_TOKEN="$TOKEN" GITHUB_REPOSITORY="$REPO" \
  pm2 start server.js --name compliance-agent
pm2 save

echo ""
echo "✅ Token gezet en app herstart. Open de app via het portaal om de"
echo "   'Update'-knop te testen; die vereist lidmaatschap van"
echo "   app-compliance-admins en werkt niet buiten de gateway om."
