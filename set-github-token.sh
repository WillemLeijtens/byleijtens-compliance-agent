#!/bin/bash
# Zet/ververst de GitHub-token waarmee de "Update"-knop in het dashboard de
# compliance-workflow op afstand start. Werkt vanuit elke map.
#
# Gebruik (in DigitalOcean web console, als root):
#   curl -sSL https://raw.githubusercontent.com/WillemLeijtens/byleijtens-compliance-agent/main/set-github-token.sh | bash -s -- "github_pat_xxxxx"

set -e

# Strip alle whitespace/newlines (copy-paste uit een terminal voegt soms
# onzichtbare tekens toe, wat Node's http-client laat crashen met
# ERR_INVALID_CHAR zodra de token in een Authorization-header komt).
TOKEN=$(printf '%s' "$1" | tr -d '[:space:]')
if [ -z "$TOKEN" ]; then
  echo "Gebruik: bash -s -- \"<token>\""
  exit 1
fi
echo "Token lengte na opschonen: ${#TOKEN} tekens"

APP_DIR=/apps/byleijtens-compliance-agent
cd "$APP_DIR"

pm2 delete compliance-agent 2>/dev/null || true
GITHUB_TOKEN="$TOKEN" GITHUB_REPOSITORY="WillemLeijtens/byleijtens-compliance-agent" pm2 start server.js --name compliance-agent
pm2 save

echo "✅ Token gezet en app herstart. Probeer de 'Update'-knop op http://$(curl -s ifconfig.me)"
