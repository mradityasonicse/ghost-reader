# 👻 WhatsApp Web Ghost Client (Zero Seen • Anti-Delete)

A stealth companion client for WhatsApp Web with:
- 🚫 **Zero Blue Ticks:** Senders will always see standard double grey ticks (✓✓).
- 🛡️ **Anti-Delete Message Vault:** Messages deleted by senders ("This message was deleted") are preserved with an alert badge and timestamp.
- 👥 **Multi-Tenant / Multi-User:** Anyone can connect their own isolated WhatsApp session with PIN protection.
- 📱 **PWA Mobile-Ready:** Full Progressive Web App support — installable on Android and iPhone with native app experience and back-button navigation.

---

## 📱 Mobile Setup (2 Ways)

### Method A: PWA Native App (Recommended — 0% Battery Drain)
1. Open the server link in Chrome (Android) or Safari (iOS).
2. Tap the **"📱 Install App"** button (or tap browser menu `⋮` / `Share` > **"Add to Home Screen"**).
3. The app will install onto your phone home screen with the **Ghost WhatsApp** icon.
4. Tap the icon to open in full screen without browser address bars!

### Method B: 100% Local on Android Phone (Termux)
If you want to run the server completely inside your Android phone's processor:
1. Install **Termux** from [F-Droid](https://f-droid.org/en/packages/com.termux/).
2. Run this command inside Termux:
   ```bash
   pkg update -y && pkg install nodejs-lts git -y
   git clone <repo-url>
   cd whatsapp-ghost-client
   npm install
   node server.js
   ```
3. Open mobile Chrome and visit `http://localhost:3000`.

---

## ☁️ Free 24/7 Cloud Deployment (No Laptop Required)

Deploy your own private instance on Render in 1 minute:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

1. Fork or push this repository to GitHub.
2. Click **Deploy to Render** or create a New Web Service on [Render.com](https://render.com) (Free tier).
3. Select Node runtime, build command `npm install`, start command `node server.js`.
4. Render will provide a permanent HTTPS URL (`https://your-app.onrender.com`)!

---

## 💻 Windows PC Setup

1. Double-click `start_server.bat` to run locally with console output.
2. Or run `start_hidden.vbs` to run silently in the background.
3. Access at `http://localhost:3000`.
