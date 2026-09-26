const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    downloadMediaMessage 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const DATA_DIR = path.join(__dirname, 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const CONFIG_FILE = path.join(DATA_DIR, 'sessions_config.json');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

function sanitizeSessionId(id) {
    if (!id) return 'default';
    return String(id).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 32) || 'default';
}

class GhostSession {
    constructor(id, meta = {}) {
        this.id = sanitizeSessionId(id);
        this.name = meta.name || (this.id === 'default' ? 'Main Account' : `Session ${this.id}`);
        this.pin = meta.pin ? String(meta.pin).trim() : null;
        this.createdAt = meta.createdAt || new Date().toISOString();

        if (this.id === 'default') {
            this.authDir = path.join(__dirname, 'auth_info_baileys');
            this.mediaDir = path.join(DATA_DIR, 'media');
        } else {
            this.sessionDir = path.join(SESSIONS_DIR, this.id);
            this.authDir = path.join(this.sessionDir, 'auth_info_baileys');
            this.mediaDir = path.join(this.sessionDir, 'media');
        }

        if (!fs.existsSync(this.authDir)) fs.mkdirSync(this.authDir, { recursive: true });
        if (!fs.existsSync(this.mediaDir)) fs.mkdirSync(this.mediaDir, { recursive: true });

        this.db = db.getDB(this.id);
        this.sock = null;
        this.connectionStatus = 'initializing';
        this.currentQrDataUrl = null;
        this.currentRawQr = null;
        this.clients = new Set(); // Connected WebSocket clients for this session
        this.reconnectTimeout = null;
    }

    broadcast(type, data) {
        const payload = JSON.stringify({
            type,
            sessionId: this.id,
            data
        });
        for (const client of this.clients) {
            if (client.readyState === 1) { // OPEN
                try {
                    client.send(payload);
                } catch (e) {
                    console.error(`[Session:${this.id}] Error sending to WS client:`, e.message);
                }
            }
        }
    }

    addClient(ws) {
        this.clients.add(ws);
        // Send initial state to newly connected client
        ws.send(JSON.stringify({
            type: 'init',
            sessionId: this.id,
            data: {
                sessionId: this.id,
                name: this.name,
                status: this.connectionStatus,
                qr: this.currentQrDataUrl,
                totalChats: this.db.chats.size
            }
        }));
    }

    removeClient(ws) {
        this.clients.delete(ws);
    }

    async downloadAndSaveMedia(rawMsg) {
        if (!rawMsg || !rawMsg.key || !rawMsg.key.id) return null;
        const id = rawMsg.key.id;

        // Check cache on disk
        if (fs.existsSync(this.mediaDir)) {
            const files = fs.readdirSync(this.mediaDir);
            const existing = files.find(f => f.startsWith(id + '.'));
            if (existing) {
                this.db.downloadedMedia.add(id);
                return { id, filename: existing, path: path.join(this.mediaDir, existing) };
            }
        }

        try {
            const buffer = await downloadMediaMessage(
                rawMsg,
                'buffer',
                {},
                { 
                    logger: pino({ level: 'silent' }),
                    reuploadRequest: this.sock ? this.sock.updateMediaMessage : undefined
                }
            );

            if (!buffer) return null;

            const unwrap = this.db.unwrapMessage(rawMsg);
            let ext = 'bin';
            if (unwrap?.imageMessage) ext = 'jpg';
            else if (unwrap?.videoMessage) ext = 'mp4';
            else if (unwrap?.audioMessage) ext = 'ogg';
            else if (unwrap?.documentMessage) ext = (unwrap.documentMessage.fileName || '').split('.').pop() || 'bin';
            else if (unwrap?.stickerMessage) ext = 'webp';

            const filename = `${id}.${ext}`;
            const filePath = path.join(this.mediaDir, filename);
            fs.writeFileSync(filePath, buffer);
            this.db.downloadedMedia.add(id);

            console.log(`[Media Engine:${this.id}] Saved ${filename} (${Math.round(buffer.length / 1024)} KB)`);

            this.broadcast('media_ready', {
                id,
                jid: rawMsg.key.remoteJid,
                url: `/api/media/${id}?session=${this.id}`,
                ext
            });

            return { id, filename, path: filePath };
        } catch (err) {
            console.error(`[Media Engine:${this.id}] Error saving media ${id}:`, err.message);
            return null;
        }
    }

    async startWhatsApp() {
        if (this.sock) {
            try {
                this.sock.end();
            } catch (e) {}
            this.sock = null;
        }

        try {
            const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
            const { version } = await fetchLatestBaileysVersion();

            console.log(`[WhatsApp Engine:${this.id}] Initializing Baileys v${version.join('.')}...`);

            this.sock = makeWASocket({
                version,
                logger: pino({ level: 'silent' }),
                printQRInTerminal: this.id === 'default',
                auth: state,
                markOnlineOnConnect: false, // Stealth Ghost mode
                syncFullHistory: true,
                generateHighQualityLinkPreview: false
            });

            this.sock.ev.on('creds.update', saveCreds);

            this.sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    this.currentRawQr = qr;
                    this.currentQrDataUrl = await QRCode.toDataURL(qr, {
                        scale: 8,
                        margin: 2,
                        color: { dark: '#000000', light: '#ffffff' }
                    });
                    this.connectionStatus = 'waiting_for_qr';
                    console.log(`[WhatsApp Engine:${this.id}] QR Code ready. Status: waiting_for_qr`);

                    this.broadcast('qr', this.currentQrDataUrl);
                    this.broadcast('status', this.connectionStatus);
                }

                if (connection === 'close') {
                    const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                    console.log(`[WhatsApp Engine:${this.id}] Connection closed (${statusCode}). Reconnect? ${shouldReconnect}`);

                    this.connectionStatus = 'disconnected';
                    this.currentQrDataUrl = null;
                    this.broadcast('status', this.connectionStatus);

                    if (shouldReconnect) {
                        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
                        this.reconnectTimeout = setTimeout(() => this.startWhatsApp(), 3000);
                    } else {
                        console.log(`[WhatsApp Engine:${this.id}] Logged out. Clearing session files...`);
                        try {
                            if (fs.existsSync(this.authDir)) fs.rmSync(this.authDir, { recursive: true, force: true });
                        } catch (e) {}
                        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
                        this.reconnectTimeout = setTimeout(() => this.startWhatsApp(), 2000);
                    }
                } else if (connection === 'open') {
                    this.connectionStatus = 'connected';
                    this.currentQrDataUrl = null;

                    const userJid = this.sock.user?.id || '';
                    const phone = userJid.split(':')[0] || userJid.split('@')[0];
                    const lid = this.sock.user?.lid || '';
                    if (phone) {
                        this.db.setUserCredentials(phone, lid);
                    }

                    console.log(`\n[WhatsApp Engine:${this.id}] CONNECTED! Phone: ${phone || 'Unknown'}. GHOST MODE ACTIVE.\n`);
                    this.broadcast('status', this.connectionStatus);
                }
            });

            // 1. History Set
            this.sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest }) => {
                console.log(`[WhatsApp Engine:${this.id}] History: ${chats?.length || 0} chats, ${contacts?.length || 0} contacts, ${messages?.length || 0} messages`);
                if (contacts?.length) {
                    for (const c of contacts) this.db.addContact(c);
                }
                if (chats?.length) {
                    for (const ch of chats) this.db.addChat(ch);
                }
                if (messages?.length) {
                    for (const m of messages) {
                        const formatted = this.db.addMessage(m);
                        if (formatted && formatted.media) {
                            this.downloadAndSaveMedia(m).catch(() => {});
                        }
                    }
                }
                this.db.saveImmediately();
                this.broadcast('history_synced', { totalChats: this.db.chats.size, isLatest });
            });

            // 2. Live Messages & Anti-Delete Engine
            this.sock.ev.on('messages.upsert', async (upsert) => {
                if (upsert.type === 'notify' || upsert.type === 'append') {
                    for (const msg of upsert.messages) {
                        // Anti-Delete Check (Revoke / Delete for Everyone)
                        const unwrap = this.db.unwrapMessage(msg);
                        const protoMsg = msg.message?.protocolMessage || unwrap?.protocolMessage;
                        if (protoMsg && (protoMsg.type === 0 || protoMsg.type === 'REVOKE')) {
                            const targetKey = protoMsg.key;
                            if (targetKey && targetKey.id) {
                                console.log(`[Anti-Delete Engine:${this.id}] Caught REVOKE for msg ${targetKey.id} in ${targetKey.remoteJid}! Preserving locally.`);
                                const deletedBy = targetKey.participant || msg.key.participant || msg.key.remoteJid;
                                const preserved = this.db.markMessageDeleted(targetKey.id, targetKey.remoteJid, deletedBy);
                                if (preserved) {
                                    this.broadcast('message_deleted', {
                                        id: targetKey.id,
                                        jid: targetKey.remoteJid,
                                        deletedAt: preserved.deletedAt,
                                        senderName: preserved.senderName,
                                        deletedBy: preserved.deletedBy
                                    });
                                }
                                continue;
                            }
                        }

                        const formatted = this.db.addMessage(msg);
                        if (formatted) {
                            console.log(`[Ghost Received:${this.id}] From: ${formatted.senderName} (${formatted.jid}) -> "${formatted.text}"`);

                            if (formatted.media) {
                                this.downloadAndSaveMedia(msg).catch(e => console.error(`[Media Engine:${this.id}]`, e.message));
                            }

                            // Strict zero-seen: do NOT call readMessages
                            this.broadcast('new_message', formatted);
                            this.broadcast('chat_updated', {
                                jid: formatted.jid,
                                canonicalJid: formatted.canonicalJid,
                                lastMessage: formatted.text,
                                lastTimestamp: formatted.timestamp
                            });
                        }
                    }
                }
            });

            // 3. Status/Revoke updates
            this.sock.ev.on('messages.update', async (updates) => {
                for (const { key, update } of updates) {
                    if (update?.messageStubType === 1 /* REVOKE */ || update?.status === 'REVOKED') {
                        console.log(`[Anti-Delete Engine:${this.id}] Caught update REVOKE for ${key.id}`);
                        const preserved = this.db.markMessageDeleted(key.id, key.remoteJid, key.participant);
                        if (preserved) {
                            this.broadcast('message_deleted', {
                                id: key.id,
                                jid: key.remoteJid,
                                deletedAt: preserved.deletedAt,
                                senderName: preserved.senderName
                            });
                        }
                    }
                }
            });

            // 4. Contacts & Chats updates
            this.sock.ev.on('contacts.upsert', (contacts) => { for (const c of contacts) this.db.addContact(c); });
            this.sock.ev.on('contacts.update', (updates) => { for (const u of updates) this.db.addContact(u); });
            this.sock.ev.on('chats.upsert', (newChats) => { for (const c of newChats) this.db.addChat(c); });
            this.sock.ev.on('chats.update', (chatUpdates) => { for (const u of chatUpdates) this.db.addChat(u); });

        } catch (err) {
            console.error(`[WhatsApp Engine:${this.id}] Critical start error:`, err);
            if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = setTimeout(() => this.startWhatsApp(), 5000);
        }
    }

    async logout() {
        try {
            if (this.sock) {
                await this.sock.logout().catch(() => {});
            }
        } catch (e) {}
        try {
            if (fs.existsSync(this.authDir)) {
                fs.rmSync(this.authDir, { recursive: true, force: true });
            }
        } catch (e) {}

        this.connectionStatus = 'disconnected';
        this.currentQrDataUrl = null;
        this.broadcast('status', this.connectionStatus);
        setTimeout(() => this.startWhatsApp(), 1500);
    }
}

class SessionManager {
    constructor() {
        this.sessions = new Map();
        this.configs = new Map();
        this.loadConfigs();
    }

    loadConfigs() {
        try {
            if (fs.existsSync(CONFIG_FILE)) {
                const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
                for (const [id, cfg] of Object.entries(data)) {
                    this.configs.set(id, cfg);
                }
            }
        } catch (e) {
            console.error('[SessionManager] Error reading config file:', e.message);
        }

        // Always ensure default session exists
        if (!this.configs.has('default')) {
            this.configs.set('default', {
                name: 'Main WhatsApp',
                createdAt: new Date().toISOString(),
                pin: null
            });
            this.saveConfigs();
        }
    }

    saveConfigs() {
        try {
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(Object.fromEntries(this.configs), null, 2), 'utf8');
        } catch (e) {
            console.error('[SessionManager] Error saving config file:', e.message);
        }
    }

    async init() {
        console.log('[SessionManager] Initializing Multi-Tenant Ghost Suite...');
        // Initialize default session
        const defaultSession = this.getOrCreateSession('default');
        defaultSession.startWhatsApp();

        // Check if there are other sessions configured or existing in data/sessions/
        try {
            if (fs.existsSync(SESSIONS_DIR)) {
                const sessionFolders = fs.readdirSync(SESSIONS_DIR);
                for (const folder of sessionFolders) {
                    if (folder !== 'default' && fs.statSync(path.join(SESSIONS_DIR, folder)).isDirectory()) {
                        console.log(`[SessionManager] Restoring saved session '${folder}'...`);
                        const s = this.getOrCreateSession(folder);
                        s.startWhatsApp();
                    }
                }
            }
        } catch (e) {
            console.error('[SessionManager] Error restoring existing sessions:', e.message);
        }
    }

    getSession(id) {
        const cleanId = sanitizeSessionId(id);
        return this.sessions.get(cleanId) || null;
    }

    getOrCreateSession(id, meta = {}) {
        const cleanId = sanitizeSessionId(id);
        if (this.sessions.has(cleanId)) {
            return this.sessions.get(cleanId);
        }

        const existingConfig = this.configs.get(cleanId) || {};
        const mergedMeta = {
            name: meta.name || existingConfig.name || (cleanId === 'default' ? 'Main Account' : cleanId),
            pin: meta.pin !== undefined ? meta.pin : (existingConfig.pin || null),
            createdAt: existingConfig.createdAt || new Date().toISOString()
        };

        this.configs.set(cleanId, mergedMeta);
        this.saveConfigs();

        const newSession = new GhostSession(cleanId, mergedMeta);
        this.sessions.set(cleanId, newSession);
        return newSession;
    }

    verifyPin(sessionId, inputPin) {
        const cleanId = sanitizeSessionId(sessionId);
        const cfg = this.configs.get(cleanId);
        if (!cfg || !cfg.pin) return true; // No PIN set
        return String(cfg.pin).trim() === String(inputPin || '').trim();
    }

    setPin(sessionId, newPin) {
        const cleanId = sanitizeSessionId(sessionId);
        const cfg = this.configs.get(cleanId) || { name: cleanId, createdAt: new Date().toISOString() };
        cfg.pin = newPin ? String(newPin).trim() : null;
        this.configs.set(cleanId, cfg);
        this.saveConfigs();

        const s = this.sessions.get(cleanId);
        if (s) s.pin = cfg.pin;
        return true;
    }

    listPublicSessions() {
        const list = [];
        for (const [id, cfg] of this.configs.entries()) {
            const active = this.sessions.get(id);
            list.push({
                id,
                name: cfg.name || id,
                status: active ? active.connectionStatus : 'offline',
                hasQr: Boolean(active?.currentQrDataUrl),
                totalChats: active ? active.db.chats.size : 0,
                hasPin: Boolean(cfg.pin),
                isDefault: id === 'default'
            });
        }
        return list;
    }

    deleteSession(id) {
        const cleanId = sanitizeSessionId(id);
        if (cleanId === 'default') {
            throw new Error('Cannot delete default primary session');
        }

        const session = this.sessions.get(cleanId);
        if (session) {
            try {
                if (session.sock) session.sock.end();
            } catch (e) {}
            this.sessions.delete(cleanId);
        }

        this.configs.delete(cleanId);
        this.saveConfigs();

        const sessionDir = path.join(SESSIONS_DIR, cleanId);
        if (fs.existsSync(sessionDir)) {
            try {
                fs.rmSync(sessionDir, { recursive: true, force: true });
            } catch (e) {}
        }

        return true;
    }
}

const sessionManager = new SessionManager();
module.exports = sessionManager;
