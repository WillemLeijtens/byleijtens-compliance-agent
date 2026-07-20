#!/bin/bash
# Volledig automatisch, veilig-opnieuw-te-draaien setup/herstel-script.
# Draait alles als root (geen gebruikerswissel meer, dat gaf verwarring).
# Kan zonder problemen meerdere keren gedraaid worden — herkent wat er al
# staat en fixt alleen wat ontbreekt.
#
# Gebruik (in DigitalOcean web console, als root):
#   curl -sSL https://raw.githubusercontent.com/WillemLeijtens/byleijtens-compliance-agent/main/setup-server.sh | bash

set -e

export DEBIAN_FRONTEND=noninteractive
APT_OPTS="-y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'
APP_DIR=/apps/byleijtens-compliance-agent

echo -e "${BLUE}[1/7] systeem + basispakketten...${NC}"
apt-get update
apt-get $APT_OPTS upgrade
command -v node &>/dev/null || { curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; apt-get install $APT_OPTS nodejs; }
apt-get install $APT_OPTS build-essential git nginx

echo -e "${BLUE}[2/7] PM2...${NC}"
command -v pm2 &>/dev/null || npm install -g pm2

echo -e "${BLUE}[3/7] firewall...${NC}"
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo -e "${BLUE}[4/7] repo clonen/updaten...${NC}"
mkdir -p /apps
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR" && git pull origin main
else
  rm -rf "$APP_DIR"
  git clone https://github.com/WillemLeijtens/byleijtens-compliance-agent.git "$APP_DIR"
fi
cd "$APP_DIR"
npm install

echo -e "${BLUE}[5/7] server (her)starten met PM2...${NC}"
# Ruim eventuele losse "node server.js" processen op die buiten pm2 om draaiden.
pkill -f "node .*server\.js" 2>/dev/null || true
pm2 delete compliance-agent 2>/dev/null || true
pm2 start server.js --name compliance-agent
pm2 save

echo -e "${BLUE}[6/7] PM2 laten overleven na reboot...${NC}"
STARTUP_CMD=$(pm2 startup systemd -u root --hp /root | tail -1)
eval "$STARTUP_CMD" || true
pm2 save

echo -e "${BLUE}[7/7] Nginx reverse proxy (poort 80 -> 3000)...${NC}"
cat > /etc/nginx/sites-available/compliance-agent <<'NGINX'
server {
  listen 80 default_server;
  server_name _;

  location / {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_cache_bypass $http_upgrade;
  }
}
NGINX
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/compliance-agent /etc/nginx/sites-enabled/compliance-agent
nginx -t
systemctl restart nginx
systemctl enable nginx

echo ""
sleep 1
if curl -sf localhost:3000 >/dev/null; then
  echo -e "${GREEN}✅ App draait en Nginx proxyt correct.${NC}"
else
  echo "⚠️  App reageert nog niet op localhost:3000 — check 'pm2 logs compliance-agent'."
fi
echo -e "${GREEN}Dashboard: http://$(curl -s ifconfig.me)${NC}"
