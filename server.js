const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const url = require('url');
const sessionManager = require('./sessionManager');
const authManager = require('./auth');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ================= Auth Endpoints =================

// Check if system has any registered users (for first-time setup UI)
app.get('/api/auth/status', (req, res) => {
    res.json({
        initialized: authManager.hasUsers(),
        totalUsers: authManager.users.length
    });
});

// Register new user (First user is automatically Master Admin)
app.post('/api/auth/register', (req, res) => {
    try {
        const { username, password, name } = req.body;
        const result = authManager.register(username, password, { name });
        
        // Auto-initialize the user's WhatsApp session
        const session = sessionManager.getOrCreateSession(result.user.sessionId, { name: result.user.name });
        if (session.connectionStatus === 'disconnected' || session.connectionStatus === 'initializing') {
            session.startWhatsApp();
        }

        res.json({
            success: true,
            message: result.isFirstUser 
                ? 'Master Admin account created successfully!' 
                : 'Account created successfully!',
            ...result
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Login
app.post('/api/auth/login', (req, res) => {
    try {
        const { username, password } = req.body;
        const result = authManager.login(username, password);

        // Ensure session is started
        const session = sessionManager.getOrCreateSession(result.user.sessionId, { name: result.user.name });
        if (session.connectionStatus === 'disconnected' || session.connectionStatus === 'initializing') {
            session.startWhatsApp();
        }

        res.json({
            success: true,
            ...result
        });
    } catch (err) {
        res.status(401).json({ error: err.message });
    }
});

// Current user profile
app.get('/api/auth/me', authManager.middleware(), (req, res) => {
    res.json({ user: req.authUser });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
    const authHeader = req.headers['authorization'];
    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7).trim();
    } else {
        token = req.headers['x-auth-token'] || req.query.token || req.body?.token;
    }
    authManager.logout(token);
    res.json({ success: true, message: 'Logged out successfully' });
});

// ================= Unified Session Middleware =================
function sessionMiddleware(req, res, next) {
    // 1. Verify Auth Token
    const authHeader = req.headers['authorization'];
    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7).trim();
    } else {
        token = req.headers['x-auth-token'] || req.query.token || req.body?.token;
    }

    if (!token) {
        return res.status(401).json({
            error: 'AUTH_REQUIRED',
            message: 'Authentication required. Please sign in to access Ghost WhatsApp.'
        });
    }

    const user = authManager.verifyToken(token);
    if (!user) {
        return res.status(401).json({
            error: 'INVALID_TOKEN',
            message: 'Session expired. Please sign in again.'
        });
    }
    req.authUser = user;

    // 2. Resolve Target Session
    let targetSessionId = user.sessionId || 'default';
    if (user.role === 'admin') {
        const requestedSession = req.headers['x-session-id'] || req.query.session || req.body?.session;
        if (requestedSession) {
            targetSessionId = String(requestedSession).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
        }
    }

    const inputPin = req.headers['x-session-pin'] || req.query.pin || req.body?.pin || null;

    // 3. Check Session PIN Protection
    if (!sessionManager.verifyPin(targetSessionId, inputPin)) {
        return res.status(401).json({
            error: 'PIN_REQUIRED',
            message: 'A 4-digit PIN is required to access this Ghost session.',
            sessionId: targetSessionId
        });
    }

    const session = sessionManager.getOrCreateSession(targetSessionId);
    req.ghostSession = session;
    next();
}

// ================= WebSocket Hub =================
wss.on('connection', (ws, req) => {
    try {
        const parsed = url.parse(req.url, true);
        const token = parsed.query.token;

        // Verify Auth Token on WebSocket handshake
        const user = authManager.verifyToken(token);
        if (!user) {
            ws.send(JSON.stringify({
                type: 'error',
                data: { code: 'AUTH_REQUIRED', message: 'Authentication required for WebSocket stream' }
            }));
            ws.close();
            return;
        }

        let targetSessionId = user.sessionId || 'default';
        if (user.role === 'admin') {
            const requested = parsed.query.session || parsed.query.sessionId;
            if (requested) {
                targetSessionId = String(requested).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
            }
        }

        const inputPin = parsed.query.pin || null;
        if (!sessionManager.verifyPin(targetSessionId, inputPin)) {
            ws.send(JSON.stringify({
                type: 'error',
                sessionId: targetSessionId,
                data: { code: 'PIN_REQUIRED', message: 'PIN authentication required' }
            }));
            ws.close();
            return;
        }

        const session = sessionManager.getOrCreateSession(targetSessionId);
        session.addClient(ws);

        ws.on('close', () => {
            session.removeClient(ws);
        });

        ws.on('error', (err) => {
            console.error(`[WebSocket:${targetSessionId}] Client error:`, err.message);
            session.removeClient(ws);
        });
    } catch (e) {
        console.error('[WebSocket] Connection routing error:', e.message);
    }
});

// ================= Session Management Endpoints =================

// List sessions available to current user
app.get('/api/sessions', authManager.middleware(), (req, res) => {
    const user = req.authUser;
    const all = sessionManager.listPublicSessions();
    if (user.role === 'admin') {
        return res.json(all);
    }
    // Non-admin only sees their own assigned session
    const mine = all.filter(s => s.id === user.sessionId);
    res.json(mine.length ? mine : [{
        id: user.sessionId,
        name: user.name || user.username,
        status: 'disconnected',
        hasQr: false,
        totalChats: 0,
        hasPin: false,
        isDefault: false
    }]);
});

// Create or connect a new session (Admin can create any; User initializes their own)
app.post('/api/sessions/create', authManager.middleware(), (req, res) => {
    try {
        const user = req.authUser;
        const requestedId = req.body.id || user.sessionId;
        const id = user.role === 'admin' ? requestedId : user.sessionId;
        const name = req.body.name || user.name || user.username;
        const pin = req.body.pin || null;

        const session = sessionManager.getOrCreateSession(id, { name, pin });
        if (session.connectionStatus === 'disconnected' || session.connectionStatus === 'initializing') {
            session.startWhatsApp();
        }

        res.json({
            success: true,
            session: {
                id: session.id,
                name: session.name,
                status: session.connectionStatus,
                hasQr: Boolean(session.currentQrDataUrl),
                hasPin: Boolean(session.pin)
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Verify PIN for a session
app.post('/api/sessions/verify-pin', authManager.middleware(), (req, res) => {
    const { id, pin } = req.body;
    const isValid = sessionManager.verifyPin(id, pin);
    res.json({ valid: isValid });
});

// Set or update PIN for a session
app.post('/api/sessions/set-pin', authManager.middleware(), (req, res) => {
    const { id, oldPin, newPin } = req.body;
    if (!sessionManager.verifyPin(id, oldPin)) {
        return res.status(401).json({ error: 'Incorrect existing PIN' });
    }
    sessionManager.setPin(id, newPin);
    res.json({ success: true, message: 'PIN updated successfully' });
});

// ================= WhatsApp Core Endpoints =================

// Session status & QR
app.get('/api/status', sessionMiddleware, (req, res) => {
    const s = req.ghostSession;
    res.json({
        sessionId: s.id,
        name: s.name,
        status: s.connectionStatus,
        hasQr: Boolean(s.currentQrDataUrl),
        qr: s.currentQrDataUrl,
        totalChats: s.db.chats.size
    });
});

// All chats for current session
app.get('/api/chats', sessionMiddleware, (req, res) => {
    res.json(req.ghostSession.db.getAllChats());
});

// Messages for selected chat
app.get('/api/messages', sessionMiddleware, (req, res) => {
    const jid = req.query.jid;
    if (!jid) return res.status(400).json({ error: 'jid is required' });
    const msgs = req.ghostSession.db.getChatMessages(jid);
    res.json(msgs);
});

// On-Demand History Fetch (Loads older messages from phone)
app.post('/api/chats/fetch-history', sessionMiddleware, async (req, res) => {
    try {
        const { jid, anchor } = req.body;
        const s = req.ghostSession;
        if (!jid) return res.status(400).json({ error: 'jid is required' });
        if (!s.sock) return res.status(503).json({ error: 'WhatsApp socket not connected for this session' });

        const target = (anchor === 'latest') ? s.db.getLatestMessage(jid) : s.db.getOldestMessage(jid);
        if (!target) {
            return res.status(404).json({ error: 'No existing message anchor found' });
        }

        const relatedJids = s.db.getRelatedJids(jid);
        const tsMs = typeof target.timestamp === 'number' && target.timestamp > 1e11 
            ? target.timestamp 
            : Number(target.timestamp);

        console.log(`[WhatsApp Engine:${s.id}] Fetching history for ${jid} around ${anchor || 'oldest'} msg (ID: ${target.id}, TS: ${tsMs})...`);

        let fetchedAny = false;
        for (const targetJid of relatedJids) {
            try {
                await s.sock.fetchMessageHistory(
                    50,
                    {
                        remoteJid: targetJid,
                        fromMe: target.fromMe,
                        id: target.id
                    },
                    tsMs
                );
                fetchedAny = true;
            } catch (err) {
                console.log(`[WhatsApp Engine:${s.id}] History fetch warning for ${targetJid}:`, err.message);
            }
        }

        res.json({ success: fetchedAny, message: 'Requested older messages from phone' });
    } catch (err) {
        console.error('Error fetching history:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Media Stream Endpoint
app.get('/api/media/:id', sessionMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        const s = req.ghostSession;

        // 1. Check if already downloaded on disk
        if (fs.existsSync(s.mediaDir)) {
            const files = fs.readdirSync(s.mediaDir);
            const existing = files.find(f => f.startsWith(id + '.'));
            if (existing) {
                s.db.downloadedMedia.add(id);
                const ext = existing.split('.').pop().toLowerCase();
                const mimeMap = {
                    'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'webp': 'image/webp',
                    'mp4': 'video/mp4', 'ogg': 'audio/ogg', 'mp3': 'audio/mpeg', 'pdf': 'application/pdf',
                    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                };
                res.type(mimeMap[ext] || 'application/octet-stream');
                return res.sendFile(path.join(s.mediaDir, existing));
            }
        }

        // 2. Lookup raw message in database
        const rawMsg = s.db.getRawMessage(id);
        if (rawMsg) {
            const saved = await s.downloadAndSaveMedia(rawMsg);
            if (saved) {
                return res.sendFile(saved.path);
            }
        }

        // 3. Not found locally
        res.status(404).json({
            error: 'Media not yet cached locally',
            id,
            canRequest: Boolean(s.sock)
        });
    } catch (err) {
        console.error(`[Media Engine] Error serving media ${req.params.id}:`, err.message);
        res.status(500).send('Media fetch error: ' + err.message);
    }
});

// Endpoint to request media resend from primary phone
app.post('/api/media/request-download', sessionMiddleware, async (req, res) => {
    try {
        const { id, jid, fromMe, participant } = req.body;
        const s = req.ghostSession;
        if (!id || !jid) {
            return res.status(400).json({ error: 'id and jid required' });
        }
        if (!s.sock) {
            return res.status(503).json({ error: 'WhatsApp socket not connected' });
        }

        console.log(`[Media Engine:${s.id}] Requesting phone resend for msg ${id} in ${jid}...`);
        await s.sock.requestPlaceholderResend({
            remoteJid: jid,
            fromMe: Boolean(fromMe),
            id: id,
            participant: participant || undefined
        });

        res.json({ success: true, message: 'Requested media from primary device' });
    } catch (err) {
        console.error(`[Media Engine] Error requesting media resend:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// Chat Export Endpoint (TXT and JSON)
app.get('/api/chats/export', sessionMiddleware, (req, res) => {
    try {
        const { jid, format } = req.query;
        const s = req.ghostSession;
        if (!jid) return res.status(400).json({ error: 'jid is required' });

        const exportFormat = format === 'json' ? 'json' : 'txt';
        const data = s.db.exportChat(jid, exportFormat);
        const contactName = s.db.resolveName(jid).replace(/[^a-zA-Z0-9_-]/g, '_');
        const filename = `GhostWhatsApp_${s.id}_${contactName}_${Date.now()}.${exportFormat}`;

        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', exportFormat === 'json' ? 'application/json' : 'text/plain; charset=utf-8');
        res.send(data);
    } catch (err) {
        console.error('[Export Engine] Error exporting chat:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Logout current WhatsApp connection
app.post('/api/logout', sessionMiddleware, async (req, res) => {
    try {
        await req.ghostSession.logout();
        res.json({ success: true, message: 'WhatsApp session disconnected successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete non-default session (Admin only)
app.delete('/api/sessions/:id', authManager.middleware(), (req, res) => {
    try {
        if (req.authUser.role !== 'admin') {
            return res.status(403).json({ error: 'Only admin can delete sessions' });
        }
        const id = req.params.id;
        sessionManager.deleteSession(id);
        res.json({ success: true, message: `Session ${id} deleted` });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

function startServer(portToTry = PORT) {
    const s = server.listen(portToTry, async () => {
        console.log(`======================================================`);
        console.log(`👻 GHOSTWHATSAPP MULTI-TENANT PRO — STEALTH SUITE`);
        console.log(`🌐 Dashboard URL: http://localhost:${portToTry}`);
        console.log(`🔒 Authentication & Route Gatekeeper: ACTIVE`);
        console.log(`🛡️ Isolated WhatsApp Sockets: ACTIVE`);
        console.log(`🚫 Anti-Delete Engine: ACTIVE`);
        console.log(`======================================================`);
        
        await sessionManager.init();
    });

    s.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`[Server] Port ${portToTry} in use, trying port ${portToTry + 1}...`);
            startServer(portToTry + 1);
        } else {
            console.error('[Server] Fatal server error:', err);
        }
    });
}

startServer(PORT);
