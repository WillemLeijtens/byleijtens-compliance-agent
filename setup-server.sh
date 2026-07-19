#!/bin/bash
# Complete server setup script voor DigitalOcean
# Usage: curl -sSL https://raw.githubusercontent.com/willemleijtens/byleijtens-compliance-agent/main/setup-server.sh | bash

set -e

echo "🚀 Starting Digital Ocean server setup..."
echo ""

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

# Step 1: Create ubuntu user
echo -e "${BLUE}Step 1: Creating ubuntu user...${NC}"
if id "ubuntu" &>/dev/null; then
    echo "Ubuntu user already exists"
else
    adduser --disabled-password --gecos "" ubuntu
    echo "ubuntu:ubuntu2024" | chpasswd
    usermod -aG sudo ubuntu
    echo -e "${GREEN}✅ Ubuntu user created${NC}"
fi

# Step 2: Update system
echo -e "${BLUE}Step 2: Updating system...${NC}"
apt update
apt upgrade -y

# Step 3: Install Node.js
echo -e "${BLUE}Step 3: Installing Node.js 22...${NC}"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs build-essential

# Step 4: Install Nginx
echo -e "${BLUE}Step 4: Installing Nginx...${NC}"
apt-get install -y nginx

# Step 5: Install PM2
echo -e "${BLUE}Step 5: Installing PM2...${NC}"
npm install -g pm2

# Step 6: Install Git
echo -e "${BLUE}Step 6: Installing Git...${NC}"
apt-get install -y git

# Step 7: Setup firewall
echo -e "${BLUE}Step 7: Setting up firewall...${NC}"
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Step 8: Create apps directory
echo -e "${BLUE}Step 8: Creating /apps directory...${NC}"
mkdir -p /apps
chown ubuntu:ubuntu /apps

# Step 9: Setup SSH key for ubuntu user
echo -e "${BLUE}Step 9: Generating GitHub deploy key...${NC}"
su - ubuntu -c "ssh-keygen -t ed25519 -C 'ubuntu@server' -f ~/.ssh/github_deploy -N ''"
echo ""
echo -e "${GREEN}✅ GitHub Deploy Key (add to GitHub repo Deploy Keys):${NC}"
su - ubuntu -c "cat ~/.ssh/github_deploy.pub"
echo ""

# Step 10: Configure SSH
echo -e "${BLUE}Step 10: Configuring SSH...${NC}"
su - ubuntu -c "cat > ~/.ssh/config << 'EOF'
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/github_deploy
  AddKeysToAgent yes
EOF"
su - ubuntu -c "chmod 600 ~/.ssh/config"

# Step 11: Setup PM2 startup
echo -e "${BLUE}Step 11: Setting up PM2 startup...${NC}"
su - ubuntu -c "pm2 startup"

echo ""
echo -e "${GREEN}✅ Server setup complete!${NC}"
echo ""
echo "📝 Next steps:"
echo "1. Copy the GitHub Deploy Key above"
echo "2. Go to GitHub repo → Settings → Deploy Keys → Add Deploy Key"
echo "3. Then run this to clone and start the app:"
echo ""
echo "   su - ubuntu"
echo "   cd /apps"
echo "   git clone git@github.com:willemleijtens/byleijtens-compliance-agent.git"
echo "   cd byleijtens-compliance-agent"
echo "   npm install"
echo "   pm2 start server.js --name compliance-agent"
echo "   pm2 save"
echo ""
