const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROJECT_DIR = __dirname;
const LOG_FILE = path.join(PROJECT_DIR, 'server.log');
const URL_FILE = path.join(PROJECT_DIR, 'PUBLIC_URL.txt');
const PID_FILE = path.join(PROJECT_DIR, 'server.pid');
const DESKTOP_DIR = path.join(process.env.USERPROFILE || 'C:\\Users\\OMEN', 'Desktop');
const SHORTCUT_FILE = path.join(DESKTOP_DIR, 'WhatsApp Ghost.url');

const NODE_BIN = process.execPath;
const CLOUDFLARED_BIN = fs.existsSync('C:\\Program Files (x86)\\cloudflared\\cloudflared.exe')
    ? 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe'
    : 'cloudflared';

function log(msg) {
    const text = `[${new Date().toISOString()}] ${msg}\n`;
    try {
        fs.appendFileSync(LOG_FILE, text);
    } catch (_) {}
    console.log(msg);
}

function savePids(launcherPid, nodePid, tunnelPid) {
    try {
        fs.writeFileSync(PID_FILE, JSON.stringify({
            launcherPid: launcherPid || null,
            nodePid: nodePid || null,
            tunnelPid: tunnelPid || null,
            updatedAt: new Date().toISOString()
        }, null, 2), 'utf8');
    } catch (_) {}
}

log('=== Starting 24/7 Ghost WhatsApp Dedicated Laptop Server ===');

let serverProcess = null;
let tunnelProcess = null;

// 1. Start Node.js Multi-Tenant Server
function startNodeServer() {
    log('Starting WhatsApp Node.js Backend...');
    serverProcess = spawn(NODE_BIN, ['server.js'], {
        cwd: PROJECT_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false
    });

    savePids(process.pid, serverProcess.pid, tunnelProcess ? tunnelProcess.pid : null);

    serverProcess.stdout.on('data', (d) => {
        const str = d.toString();
        try { fs.appendFileSync(LOG_FILE, str); } catch (_) {}
        process.stdout.write(str);
    });

    serverProcess.stderr.on('data', (d) => {
        const str = d.toString();
        try { fs.appendFileSync(LOG_FILE, str); } catch (_) {}
        process.stderr.write(str);
    });

    serverProcess.on('exit', (code) => {
        log(`Node server exited with code ${code}. Restarting in 3s...`);
        serverProcess = null;
        savePids(process.pid, null, tunnelProcess ? tunnelProcess.pid : null);
        setTimeout(startNodeServer, 3000);
    });
}

// 2. Start Cloudflare 24/7 Global Tunnel
function startCloudflareTunnel() {
    log('Starting Cloudflare 24/7 Global Tunnel...');
    tunnelProcess = spawn(CLOUDFLARED_BIN, ['tunnel', '--url', 'http://localhost:3000'], {
        cwd: PROJECT_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false
    });

    savePids(process.pid, serverProcess ? serverProcess.pid : null, tunnelProcess.pid);

    const handleOutput = (d) => {
        const str = d.toString();
        try { fs.appendFileSync(LOG_FILE, str); } catch (_) {}
        process.stdout.write(str);

        // Regex match for Cloudflare quick tunnel URL
        const match = str.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) {
            const publicUrl = match[0];
            log(`\n======================================================`);
            log(`🌍 24/7 PUBLIC GHOST URL: ${publicUrl}`);
            log(`======================================================\n`);

            // Save to PUBLIC_URL.txt
            fs.writeFileSync(URL_FILE, publicUrl, 'utf8');

            // Save to Desktop shortcut
            try {
                const shortcutContent = `[InternetShortcut]\nURL=${publicUrl}\nIconIndex=0\n`;
                fs.writeFileSync(SHORTCUT_FILE, shortcutContent, 'utf8');
                log(`[Desktop] Created shortcut: "${SHORTCUT_FILE}"`);
            } catch (e) {
                log(`[Desktop Error] ${e.message}`);
            }
        }
    };

    tunnelProcess.stdout.on('data', handleOutput);
    tunnelProcess.stderr.on('data', handleOutput);

    tunnelProcess.on('exit', (code) => {
        log(`Cloudflare tunnel exited with code ${code}. Restarting in 5s...`);
        tunnelProcess = null;
        savePids(process.pid, serverProcess ? serverProcess.pid : null, null);
        setTimeout(startCloudflareTunnel, 5000);
    });
}

// Start both
startNodeServer();
setTimeout(startCloudflareTunnel, 2000);

function cleanup() {
    log('Shutting down server processes...');
    try {
        if (serverProcess) serverProcess.kill();
        if (tunnelProcess) tunnelProcess.kill();
        if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    } catch (_) {}
    process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
