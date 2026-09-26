const fs = require('fs');
const path = require('path');

const ROOT_DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(ROOT_DATA_DIR)) fs.mkdirSync(ROOT_DATA_DIR, { recursive: true });

class GhostDB {
    constructor(sessionId = 'default') {
        this.sessionId = String(sessionId || 'default').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_') || 'default';
        if (this.sessionId === 'default') {
            this.dbDir = path.join(__dirname, 'data');
            this.dbFile = path.join(this.dbDir, 'ghost_db.json');
            this.rawFile = path.join(this.dbDir, 'raw_media_messages.json');
            this.mediaDir = path.join(this.dbDir, 'media');
            this.authDir = path.join(__dirname, 'auth_info_baileys');
        } else {
            this.dbDir = path.join(__dirname, 'data', 'sessions', this.sessionId);
            this.dbFile = path.join(this.dbDir, 'ghost_db.json');
            this.rawFile = path.join(this.dbDir, 'raw_media_messages.json');
            this.mediaDir = path.join(this.dbDir, 'media');
            this.authDir = path.join(this.dbDir, 'auth_info_baileys');
        }

        if (!fs.existsSync(this.dbDir)) fs.mkdirSync(this.dbDir, { recursive: true });
        if (!fs.existsSync(this.mediaDir)) fs.mkdirSync(this.mediaDir, { recursive: true });
        if (!fs.existsSync(this.authDir)) fs.mkdirSync(this.authDir, { recursive: true });

        this.chats = new Map();
        this.contacts = new Map();
        this.messages = new Map(); // raw jid -> Array of messages
        this.rawMessages = new Map(); // id -> rawMsg for media downloading
        this.downloadedMedia = new Set(); // Cached media IDs on disk
        this.lidToPhone = new Map();
        this.phoneToLid = new Map();
        this.myNumber = process.env.DEFAULT_MY_NUMBER || '';
        this.myLid = process.env.DEFAULT_MY_LID || '';
        this.saveTimeout = null;
        this.rawSaveTimeout = null;

        this.loadLidMappings();
        this.loadDownloadedMedia();
        this.load();
        this.loadRawMessages();
        this.migrateLegacyMediaMessages();
    }

    setUserCredentials(number, lid) {
        if (number) this.myNumber = String(number).replace(/\D/g, '');
        if (lid) this.myLid = String(lid).split('@')[0];
    }

    loadDownloadedMedia() {
        try {
            if (fs.existsSync(this.mediaDir)) {
                const files = fs.readdirSync(this.mediaDir);
                for (const f of files) {
                    const id = f.split('.')[0];
                    if (id) this.downloadedMedia.add(id);
                }
                console.log(`[GhostDB:${this.sessionId}] Loaded ${this.downloadedMedia.size} local cached media files.`);
            }
        } catch (e) {
            console.error(`[GhostDB:${this.sessionId}] Error loading media cache list:`, e.message);
        }
    }

    migrateLegacyMediaMessages() {
        let count = 0;
        for (const [jid, msgs] of this.messages.entries()) {
            for (const m of msgs) {
                if (!m.media && m.text) {
                    if (m.text.startsWith('📷 [Photo]') || m.text === '📷 Photo') {
                        const caption = m.text.replace('📷 [Photo]', '').replace('📷 Photo', '').trim();
                        m.media = {
                            type: 'image',
                            caption: caption,
                            mimetype: 'image/jpeg'
                        };
                        count++;
                    } else if (m.text.startsWith('🎥 [Video]') || m.text === '🎥 Video') {
                        const caption = m.text.replace('🎥 [Video]', '').replace('🎥 Video', '').trim();
                        m.media = {
                            type: 'video',
                            caption: caption,
                            mimetype: 'video/mp4'
                        };
                        count++;
                    } else if (m.text.startsWith('🎤 [Voice Note]') || m.text === '🎤 Voice Note') {
                        m.media = {
                            type: 'audio',
                            isVoiceNote: true,
                            mimetype: 'audio/ogg; codecs=opus'
                        };
                        count++;
                    } else if (m.text.startsWith('🎵 [Audio]') || m.text === '🎵 Audio') {
                        m.media = {
                            type: 'audio',
                            isVoiceNote: false,
                            mimetype: 'audio/mpeg'
                        };
                        count++;
                    } else if (m.text.startsWith('📄 [Document]') || m.text === '📄 Document') {
                        const fileName = m.text.replace('📄 [Document]', '').replace('📄 Document', '').trim() || 'Document';
                        m.media = {
                            type: 'document',
                            fileName: fileName,
                            mimetype: 'application/octet-stream'
                        };
                        count++;
                    } else if (m.text.startsWith('🎨 [Sticker]') || m.text === '🎨 Sticker') {
                        m.media = {
                            type: 'sticker',
                            mimetype: 'image/webp'
                        };
                        count++;
                    }
                }
            }
        }
        if (count > 0) {
            console.log(`[GhostDB] Migrated ${count} legacy media messages with media metadata.`);
            this.scheduleSave();
        }
    }

    loadLidMappings() {
        try {
            if (fs.existsSync(this.authDir)) {
                const files = fs.readdirSync(this.authDir);
                for (const f of files) {
                    if (f.startsWith('lid-mapping-')) {
                        if (f.endsWith('_reverse.json')) {
                            const lid = f.replace('lid-mapping-', '').replace('_reverse.json', '');
                            try {
                                const phone = JSON.parse(fs.readFileSync(path.join(this.authDir, f), 'utf8'));
                                if (phone) {
                                    this.lidToPhone.set(lid, String(phone));
                                    this.phoneToLid.set(String(phone), lid);
                                }
                            } catch (e) {}
                        } else if (f.endsWith('.json')) {
                            const phone = f.replace('lid-mapping-', '').replace('.json', '');
                            try {
                                const lid = JSON.parse(fs.readFileSync(path.join(this.authDir, f), 'utf8'));
                                if (lid) {
                                    this.phoneToLid.set(phone, String(lid));
                                    this.lidToPhone.set(String(lid), phone);
                                }
                            } catch (e) {}
                        }
                    }
                }
                console.log(`[GhostDB:${this.sessionId}] Loaded ${this.lidToPhone.size} LID<->Phone mappings.`);
            }
        } catch (err) {
            console.error(`[GhostDB:${this.sessionId}] Error loading LID mappings:`, err.message);
        }
    }

    loadRawMessages() {
        try {
            if (fs.existsSync(this.rawFile)) {
                const rawObj = JSON.parse(fs.readFileSync(this.rawFile, 'utf8'));
                for (const [k, v] of Object.entries(rawObj)) {
                    this.rawMessages.set(k, v);
                }
                console.log(`[GhostDB:${this.sessionId}] Loaded ${this.rawMessages.size} raw media message payloads.`);
            }
        } catch (err) {
            console.error(`[GhostDB:${this.sessionId}] Error loading raw messages:`, err.message);
        }
    }

    scheduleRawSave() {
        if (this.rawSaveTimeout) clearTimeout(this.rawSaveTimeout);
        this.rawSaveTimeout = setTimeout(() => {
            try {
                // Keep last 1500 raw media messages to manage disk size
                const entries = Array.from(this.rawMessages.entries()).slice(-1500);
                fs.writeFileSync(this.rawFile, JSON.stringify(Object.fromEntries(entries)), 'utf8');
            } catch (e) {
                console.error(`[GhostDB:${this.sessionId}] Error saving raw messages:`, e.message);
            }
        }, 3000);
    }

    getCanonicalJid(jid) {
        if (!jid) return 'unknown';
        if (jid === 'me' || jid.includes(this.myNumber) || (this.myLid && jid.includes(this.myLid))) {
            return `${this.myNumber}@s.whatsapp.net`;
        }
        if (jid.endsWith('@g.us')) return jid;
        if (jid.endsWith('@lid')) {
            const lid = jid.split('@')[0];
            const phone = this.lidToPhone.get(lid);
            if (phone) return `${phone}@s.whatsapp.net`;
            return jid;
        }
        return jid;
    }

    getRelatedJids(jid) {
        const list = new Set();
        if (!jid) return [];

        list.add(jid);

        if (jid === 'me' || jid.includes(this.myNumber) || (this.myLid && jid.includes(this.myLid))) {
            list.add(`${this.myNumber}@s.whatsapp.net`);
            list.add(`${this.myLid}@lid`);
            return Array.from(list);
        }

        if (jid.endsWith('@lid')) {
            const lid = jid.split('@')[0];
            const phone = this.lidToPhone.get(lid);
            if (phone) list.add(`${phone}@s.whatsapp.net`);
        } else if (jid.endsWith('@s.whatsapp.net')) {
            const phone = jid.split('@')[0];
            const lid = this.phoneToLid.get(phone);
            if (lid) list.add(`${lid}@lid`);
        }

        return Array.from(list);
    }

    formatPhoneNumber(number) {
        if (!number) return '';
        const digits = number.replace(/\D/g, '');
        if (digits.startsWith('91') && digits.length === 12) {
            return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
        }
        return `+${digits}`;
    }

    resolveName(jid, groupName = null) {
        if (!jid) return 'Unknown';

        if (jid === 'me' || jid.includes(this.myNumber) || (this.myLid && jid.includes(this.myLid))) {
            return 'You (Message Yourself)';
        }

        if (jid.endsWith('@g.us')) {
            if (groupName && groupName.trim() && !groupName.endsWith('@g.us')) return groupName;
            const chat = this.chats.get(jid);
            if (chat && chat.name && chat.name.trim() && !chat.name.endsWith('@g.us')) {
                return chat.name;
            }
            return 'WhatsApp Group';
        }

        let phone = null;
        if (jid.endsWith('@s.whatsapp.net')) {
            phone = jid.split('@')[0];
        } else if (jid.endsWith('@lid')) {
            const lid = jid.split('@')[0];
            phone = this.lidToPhone.get(lid);
        } else {
            phone = jid.split('@')[0];
        }

        if (phone) {
            const contact = this.contacts.get(`${phone}@s.whatsapp.net`);
            if (contact && contact.name && contact.name.trim()) return contact.name;
            if (contact && contact.notify && contact.notify.trim()) return contact.notify;
            return this.formatPhoneNumber(phone);
        }

        const directContact = this.contacts.get(jid);
        if (directContact && directContact.name && directContact.name.trim()) return directContact.name;

        return jid.split('@')[0];
    }

    load() {
        try {
            if (fs.existsSync(this.dbFile)) {
                const data = JSON.parse(fs.readFileSync(this.dbFile, 'utf8'));
                if (data.contacts) {
                    for (const [k, v] of Object.entries(data.contacts)) this.contacts.set(k, v);
                }
                if (data.chats) {
                    for (const [k, v] of Object.entries(data.chats)) this.chats.set(k, v);
                }
                if (data.messages) {
                    for (const [k, v] of Object.entries(data.messages)) this.messages.set(k, v);
                }
                console.log(`[GhostDB:${this.sessionId}] Loaded ${this.chats.size} chats, ${this.contacts.size} contacts, ${this.messages.size} threads.`);
            }
        } catch (err) {
            console.error(`[GhostDB:${this.sessionId}] Error loading database:`, err.message);
        }
    }

    scheduleSave() {
        if (this.saveTimeout) clearTimeout(this.saveTimeout);
        this.saveTimeout = setTimeout(() => this.saveImmediately(), 1500);
    }

    saveImmediately() {
        try {
            const payload = {
                contacts: Object.fromEntries(this.contacts),
                chats: Object.fromEntries(this.chats),
                messages: Object.fromEntries(this.messages)
            };
            fs.writeFileSync(this.dbFile, JSON.stringify(payload, null, 2), 'utf8');
        } catch (err) {
            console.error(`[GhostDB:${this.sessionId}] Error writing database:`, err.message);
        }
    }

    addContact(contact) {
        if (!contact || !contact.id) return;
        const existing = this.contacts.get(contact.id) || {};
        const name = contact.name || contact.notify || contact.verifiedName || existing.name || '';
        this.contacts.set(contact.id, {
            id: contact.id,
            name: name,
            notify: contact.notify || existing.notify || '',
            number: contact.id.split('@')[0]
        });

        if (contact.id.endsWith('@lid')) {
            const lid = contact.id.split('@')[0];
            const phone = this.lidToPhone.get(lid);
            if (phone && name) {
                const phoneKey = `${phone}@s.whatsapp.net`;
                const existingPhone = this.contacts.get(phoneKey) || {};
                this.contacts.set(phoneKey, {
                    id: phoneKey,
                    name: name || existingPhone.name || '',
                    notify: contact.notify || existingPhone.notify || '',
                    number: phone
                });
            }
        }
        this.scheduleSave();
    }

    addChat(chat) {
        if (!chat || !chat.id) return;
        const isGroup = chat.id.endsWith('@g.us');
        const existing = this.chats.get(chat.id) || {};
        const rawName = chat.name || existing.name || '';
        const resolved = this.resolveName(chat.id, rawName);

        this.chats.set(chat.id, {
            id: chat.id,
            name: resolved,
            rawName: rawName,
            isGroup: isGroup,
            unreadCount: chat.unreadCount !== undefined ? chat.unreadCount : (existing.unreadCount || 0),
            lastMessage: chat.lastMessage || existing.lastMessage || '',
            lastTimestamp: chat.conversationTimestamp || chat.lastTimestamp || existing.lastTimestamp || 0
        });
        this.scheduleSave();
    }

    unwrapMessage(m) {
        if (!m) return null;
        let msg = m.message;
        if (!msg) return null;

        if (msg.ephemeralMessage?.message) msg = msg.ephemeralMessage.message;
        if (msg.viewOnceMessage?.message) msg = msg.viewOnceMessage.message;
        if (msg.viewOnceMessageV2?.message) msg = msg.viewOnceMessageV2.message;
        if (msg.viewOnceMessageV2Extension?.message) msg = msg.viewOnceMessageV2Extension.message;
        if (msg.documentWithCaptionMessage?.message) msg = msg.documentWithCaptionMessage.message;
        if (msg.editedMessage?.message?.protocolMessage?.editedMessage) {
            msg = msg.editedMessage.message.protocolMessage.editedMessage;
        }

        return msg;
    }

    extractMediaInfo(m) {
        const msg = this.unwrapMessage(m);
        if (!msg) return null;

        if (msg.imageMessage) {
            return {
                type: 'image',
                mimetype: msg.imageMessage.mimetype || 'image/jpeg',
                caption: msg.imageMessage.caption || '',
                thumbnail: msg.imageMessage.jpegThumbnail 
                    ? `data:image/jpeg;base64,${Buffer.from(msg.imageMessage.jpegThumbnail).toString('base64')}` 
                    : null
            };
        }
        if (msg.videoMessage) {
            return {
                type: 'video',
                mimetype: msg.videoMessage.mimetype || 'video/mp4',
                caption: msg.videoMessage.caption || '',
                seconds: msg.videoMessage.seconds || 0,
                thumbnail: msg.videoMessage.jpegThumbnail 
                    ? `data:image/jpeg;base64,${Buffer.from(msg.videoMessage.jpegThumbnail).toString('base64')}` 
                    : null
            };
        }
        if (msg.audioMessage) {
            return {
                type: 'audio',
                isVoiceNote: Boolean(msg.audioMessage.ptt),
                seconds: msg.audioMessage.seconds || 0,
                mimetype: msg.audioMessage.mimetype || 'audio/ogg; codecs=opus'
            };
        }
        if (msg.documentMessage) {
            return {
                type: 'document',
                fileName: msg.documentMessage.fileName || 'Document',
                fileLength: msg.documentMessage.fileLength || 0,
                mimetype: msg.documentMessage.mimetype || 'application/octet-stream',
                thumbnail: msg.documentMessage.jpegThumbnail 
                    ? `data:image/jpeg;base64,${Buffer.from(msg.documentMessage.jpegThumbnail).toString('base64')}` 
                    : null
            };
        }
        if (msg.stickerMessage) {
            return {
                type: 'sticker',
                mimetype: msg.stickerMessage.mimetype || 'image/webp'
            };
        }

        return null;
    }

    extractMessageText(m) {
        const msg = this.unwrapMessage(m);
        if (!msg) return '';

        if (msg.conversation && msg.conversation.trim()) return msg.conversation.trim();
        if (msg.extendedTextMessage?.text && msg.extendedTextMessage.text.trim()) {
            return msg.extendedTextMessage.text.trim();
        }

        if (msg.imageMessage?.caption) return msg.imageMessage.caption;
        if (msg.imageMessage) return '📷 Photo';
        
        if (msg.videoMessage?.caption) return msg.videoMessage.caption;
        if (msg.videoMessage) return '🎥 Video';

        if (msg.audioMessage?.ptt) return '🎤 Voice Note';
        if (msg.audioMessage) return '🎵 Audio';

        if (msg.documentMessage?.fileName) return `📄 ${msg.documentMessage.fileName}`;
        if (msg.documentMessage) return '📄 Document';

        if (msg.stickerMessage) return '🎨 Sticker';
        if (msg.contactMessage?.displayName) return `👤 Contact: ${msg.contactMessage.displayName}`;
        if (msg.contactsArrayMessage?.contacts) return `👥 ${msg.contactsArrayMessage.contacts.length} Contacts`;
        if (msg.locationMessage) return '📍 Location';
        if (msg.liveLocationMessage) return '📍 Live Location';
        if (msg.pollCreationMessage || msg.pollCreationMessageV2 || msg.pollCreationMessageV3) {
            const pollName = msg.pollCreationMessage?.name || msg.pollCreationMessageV2?.name || msg.pollCreationMessageV3?.name || '';
            return `📊 Poll: ${pollName}`;
        }
        if (msg.reactionMessage?.text) return `Reaction: ${msg.reactionMessage.text}`;

        if (msg.protocolMessage) return '';
        return '';
    }

    addMessage(rawMsg) {
        if (!rawMsg || !rawMsg.key) return null;
        const jid = rawMsg.key.remoteJid;
        if (!jid || jid === 'status@broadcast') return null;

        const text = this.extractMessageText(rawMsg);
        const media = this.extractMediaInfo(rawMsg);

        if (!text && !media) return null;

        const isGroup = jid.endsWith('@g.us');
        const fromMe = Boolean(rawMsg.key.fromMe);
        const timestamp = rawMsg.messageTimestamp 
            ? (typeof rawMsg.messageTimestamp === 'number' ? rawMsg.messageTimestamp * 1000 : Number(rawMsg.messageTimestamp) * 1000)
            : Date.now();

        let senderJid = fromMe ? 'me' : (rawMsg.key.participant || jid);
        let senderName = fromMe ? 'You' : this.resolveName(senderJid);

        const formattedMsg = {
            id: rawMsg.key.id,
            jid: jid,
            canonicalJid: this.getCanonicalJid(jid),
            fromMe: fromMe,
            senderJid: senderJid,
            senderName: senderName,
            text: text || (media ? `${media.type.toUpperCase()}` : ''),
            media: media,
            timestamp: timestamp,
            status: 'ghost_received',
            isDeleted: false,
            deletedAt: null,
            deletedBy: null
        };

        // Cache raw message if it has media
        if (media) {
            this.rawMessages.set(rawMsg.key.id, rawMsg);
            this.scheduleRawSave();
        }

        if (!this.messages.has(jid)) {
            this.messages.set(jid, []);
        }
        const chatMsgs = this.messages.get(jid);
        const existingIdx = chatMsgs.findIndex(m => m.id === formattedMsg.id);
        if (existingIdx === -1) {
            chatMsgs.push(formattedMsg);
            chatMsgs.sort((a, b) => a.timestamp - b.timestamp);
        } else {
            // Preserve anti-delete state if previously marked
            formattedMsg.isDeleted = chatMsgs[existingIdx].isDeleted || false;
            formattedMsg.deletedAt = chatMsgs[existingIdx].deletedAt || null;
            formattedMsg.deletedBy = chatMsgs[existingIdx].deletedBy || null;
            chatMsgs[existingIdx] = { ...chatMsgs[existingIdx], ...formattedMsg };
        }

        const existingChat = this.chats.get(jid) || {};
        const chatName = this.resolveName(jid, existingChat.rawName || existingChat.name);
        
        this.chats.set(jid, {
            id: jid,
            name: chatName,
            rawName: existingChat.rawName || '',
            isGroup: isGroup,
            lastMessage: formattedMsg.text,
            lastTimestamp: Math.max(timestamp, existingChat.lastTimestamp || 0),
            unreadCount: (existingChat.unreadCount || 0) + (fromMe ? 0 : 1)
        });

        this.scheduleSave();
        return formattedMsg;
    }

    getRawMessage(id) {
        return this.rawMessages.get(id);
    }

    markMessageDeleted(targetId, targetJid = null, deletedBy = null) {
        if (!targetId) return null;
        let found = null;

        for (const [jid, msgs] of this.messages.entries()) {
            for (const m of msgs) {
                if (m.id === targetId) {
                    m.isDeleted = true;
                    m.deletedAt = Date.now();
                    m.deletedBy = deletedBy ? this.resolveName(deletedBy) : (m.senderName || 'Sender');
                    found = m;
                    break;
                }
            }
            if (found) break;
        }

        if (found) {
            console.log(`[GhostDB Anti-Delete] Message ${targetId} preserved & marked as DELETED.`);
            this.scheduleSave();
            return found;
        }
        return null;
    }

    exportChat(requestedJid, format = 'txt') {
        const msgs = this.getChatMessages(requestedJid);
        const chatName = this.resolveName(requestedJid);

        if (format === 'json') {
            return JSON.stringify({
                chatName,
                jid: requestedJid,
                exportedAt: new Date().toISOString(),
                totalMessages: msgs.length,
                messages: msgs
            }, null, 2);
        }

        let output = `=========================================================\n`;
        output += `👻 WHATSAPP GHOST CLIENT — CHAT EXPORT\n`;
        output += `Conversation With: ${chatName} (${requestedJid})\n`;
        output += `Exported On: ${new Date().toLocaleString()}\n`;
        output += `Total Messages Preserved: ${msgs.length}\n`;
        output += `=========================================================\n\n`;

        for (const m of msgs) {
            const time = new Date(m.timestamp).toLocaleString();
            const sender = m.senderName || (m.fromMe ? 'You' : 'Contact');
            const deletedTag = m.isDeleted ? ` [🚫 DELETED BY SENDER AT ${new Date(m.deletedAt || m.timestamp).toLocaleTimeString()}]` : '';
            const mediaTag = m.media ? ` [ATTACHMENT: ${m.media.type.toUpperCase()}${m.media.fileName ? ` - ${m.media.fileName}` : ''}]` : '';
            output += `[${time}] ${sender}${deletedTag}${mediaTag}:\n${m.text || ''}\n\n`;
        }

        return output;
    }

    getOldestMessage(requestedJid) {
        const related = this.getRelatedJids(requestedJid);
        let oldest = null;

        for (const jid of related) {
            const list = this.messages.get(jid) || [];
            for (const m of list) {
                if (!oldest || m.timestamp < oldest.timestamp) {
                    oldest = m;
                }
            }
        }
        return oldest;
    }

    getLatestMessage(requestedJid) {
        const related = this.getRelatedJids(requestedJid);
        let latest = null;

        for (const jid of related) {
            const list = this.messages.get(jid) || [];
            for (const m of list) {
                if (!latest || m.timestamp > latest.timestamp) {
                    latest = m;
                }
            }
        }
        return latest;
    }

    getAllChats() {
        this.loadLidMappings();
        const canonicalMap = new Map();

        // 1. Collect messages from all raw threads
        for (const [rawJid, msgs] of this.messages.entries()) {
            if (!msgs || msgs.length === 0) continue;

            const canonKey = this.getCanonicalJid(rawJid);
            if (!canonicalMap.has(canonKey)) {
                canonicalMap.set(canonKey, {
                    id: canonKey,
                    rawJids: new Set([rawJid]),
                    messages: [],
                    unreadCount: 0
                });
            }
            const entry = canonicalMap.get(canonKey);
            entry.rawJids.add(rawJid);
            entry.messages.push(...msgs);
        }

        // 2. Merge chats metadata
        for (const [rawJid, chat] of this.chats.entries()) {
            const canonKey = this.getCanonicalJid(rawJid);
            if (!canonicalMap.has(canonKey)) {
                canonicalMap.set(canonKey, {
                    id: canonKey,
                    rawJids: new Set([rawJid]),
                    messages: [],
                    unreadCount: chat.unreadCount || 0,
                    fallbackName: chat.rawName || chat.name,
                    lastMessage: chat.lastMessage,
                    lastTimestamp: chat.lastTimestamp || 0
                });
            } else {
                const entry = canonicalMap.get(canonKey);
                entry.rawJids.add(rawJid);
                entry.unreadCount = Math.max(entry.unreadCount, chat.unreadCount || 0);
                if (chat.rawName && !entry.fallbackName) {
                    entry.fallbackName = chat.rawName;
                }
            }
        }

        // 3. Include contacts with saved names
        for (const [contactJid, contact] of this.contacts.entries()) {
            if (!contact || !contact.name || !contact.name.trim()) continue;
            const canonKey = this.getCanonicalJid(contactJid);
            if (!canonicalMap.has(canonKey)) {
                canonicalMap.set(canonKey, {
                    id: canonKey,
                    rawJids: new Set([contactJid]),
                    messages: [],
                    unreadCount: 0,
                    fallbackName: contact.name,
                    lastMessage: '',
                    lastTimestamp: 0
                });
            }
        }

        // Final list formatting
        const results = [];
        for (const [canonKey, entry] of canonicalMap.entries()) {
            const isGroup = canonKey.endsWith('@g.us');
            const resolvedName = this.resolveName(canonKey, entry.fallbackName);

            let lastMessage = entry.lastMessage || '';
            let lastTimestamp = entry.lastTimestamp || 0;

            if (entry.messages.length > 0) {
                const seenIds = new Set();
                const uniqueMsgs = [];
                for (const m of entry.messages) {
                    if (!seenIds.has(m.id)) {
                        seenIds.add(m.id);
                        uniqueMsgs.push(m);
                    }
                }
                uniqueMsgs.sort((a, b) => a.timestamp - b.timestamp);
                const lastMsg = uniqueMsgs[uniqueMsgs.length - 1];
                lastMessage = lastMsg.text;
                lastTimestamp = lastMsg.timestamp;
            }

            results.push({
                id: canonKey,
                name: resolvedName,
                isGroup: isGroup,
                unreadCount: entry.unreadCount || 0,
                lastMessage: lastMessage || 'Tap to view conversation',
                lastTimestamp: lastTimestamp,
                messageCount: entry.messages.length
            });
        }

        results.sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));
        return results;
    }

    getChatMessages(requestedJid) {
        const related = this.getRelatedJids(requestedJid);
        const allMsgs = [];
        const seenIds = new Set();

        for (const jid of related) {
            const list = this.messages.get(jid) || [];
            for (const m of list) {
                if (!seenIds.has(m.id)) {
                    seenIds.add(m.id);
                    allMsgs.push(m);
                }
            }
        }

        allMsgs.sort((a, b) => a.timestamp - b.timestamp);

        return allMsgs.map(m => {
            const media = m.media ? {
                ...m.media,
                downloaded: this.downloadedMedia.has(m.id),
                url: `/api/media/${m.id}`
            } : null;

            return {
                ...m,
                media,
                senderName: m.fromMe ? 'You' : this.resolveName(m.senderJid)
            };
        });
    }
}

const defaultInstance = new GhostDB('default');
const instances = new Map([['default', defaultInstance]]);

function getDB(sessionId = 'default') {
    const cleanId = String(sessionId || 'default').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_') || 'default';
    if (!instances.has(cleanId)) {
        instances.set(cleanId, new GhostDB(cleanId));
    }
    return instances.get(cleanId);
}

module.exports = defaultInstance;
module.exports.GhostDB = GhostDB;
module.exports.getDB = getDB;
