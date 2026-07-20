#!/bin/bash
# Complete, fully automatic server setup voor DigitalOcean.
# Repo is public, dus geen token/deploy key nodig — plain HTTPS clone.
#
# Usage (in DigitalOcean web console, als root):
#   curl -sSL https://raw.githubusercontent.com/willemleijtens/byleijtens-compliance-agent/main/setup-server.sh | bash

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}Step 1/7: systeem updaten...${NC}"
apt update && apt upgrade -y

echo -e "${BLUE}Step 2/7: Node.js 22 installeren...${NC}"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs build-essential git nginx

echo -e "${BLUE}Step 3/7: PM2 installeren...${NC}"
npm install -g pm2

echo -e "${BLUE}Step 4/7: ubuntu-user en /apps directory...${NC}"
id -u ubuntu &>/dev/null || adduser --disabled-password --gecos "" ubuntu
usermod -aG sudo ubuntu
mkdir -p /apps
chown ubuntu:ubuntu /apps

echo -e "${BLUE}Step 5/7: firewall...${NC}"
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo -e "${BLUE}Step 6/7: repo clonen en app starten...${NC}"
su - ubuntu -c "git clone https://github.com/WillemLeijtens/byleijtens-compliance-agent.git /apps/byleijtens-compliance-agent"
su - ubuntu -c "cd /apps/byleijtens-compliance-agent && npm install"
su - ubuntu -c "cd /apps/byleijtens-compliance-agent && pm2 start server.js --name compliance-agent"
su - ubuntu -c "pm2 save"
env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu | tail -1 > /root/pm2-startup-cmd.sh
bash /root/pm2-startup-cmd.sh || true

echo -e "${BLUE}Step 7/7: Nginx reverse proxy...${NC}"
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
nginx -t && systemctl restart nginx

echo ""
echo -e "${GREEN}✅ Setup compleet! Dashboard draait nu op http://$(curl -s ifconfig.me)${NC}"
