#!/data/data/com.termux/files/usr/bin/bash
# ==========================================================
# WhatsApp Ghost Client — Termux 1-Click Android Setup
# ==========================================================
echo "=== Installing WhatsApp Ghost locally on Android ==="

pkg update -y && pkg install nodejs-lts git -y

if [ ! -d "whatsapp-ghost-client" ]; then
    echo "Cloning repository..."
    # Replace with your repo url if hosted on GitHub
    git clone https://github.com/your-username/whatsapp-ghost-client.git
    cd whatsapp-ghost-client
else
    cd whatsapp-ghost-client
    git pull
fi

echo "Installing dependencies..."
npm install --omit=dev

echo "=========================================================="
echo "Starting WhatsApp Ghost Local Server on Android..."
echo "Open Chrome on your phone and go to: http://localhost:3000"
echo "=========================================================="
node server.js
