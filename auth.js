const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const TOKENS_FILE = path.join(DATA_DIR, 'auth_tokens.json');

class AuthManager {
    constructor() {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        this.users = this.loadJson(USERS_FILE, []);
        this.tokens = this.loadJson(TOKENS_FILE, {});
    }

    loadJson(filePath, defaultValue) {
        try {
            if (fs.existsSync(filePath)) {
                return JSON.parse(fs.readFileSync(filePath, 'utf8'));
            }
        } catch (e) {
            console.error(`[Auth] Error reading ${filePath}:`, e.message);
        }
        return defaultValue;
    }

    saveUsers() {
        try {
            fs.writeFileSync(USERS_FILE, JSON.stringify(this.users, null, 2), 'utf8');
        } catch (e) {
            console.error('[Auth] Error saving users:', e.message);
        }
    }

    saveTokens() {
        try {
            fs.writeFileSync(TOKENS_FILE, JSON.stringify(this.tokens, null, 2), 'utf8');
        } catch (e) {
            console.error('[Auth] Error saving tokens:', e.message);
        }
    }

    hasUsers() {
        return this.users.length > 0;
    }

    hashPassword(password, salt) {
        return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    }

    register(rawUsername, password, options = {}) {
        const username = String(rawUsername || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
        if (!username || username.length < 3) {
            throw new Error('Username must be at least 3 characters (letters, numbers, underscores).');
        }
        if (!password || password.length < 4) {
            throw new Error('Password must be at least 4 characters.');
        }

        const existing = this.users.find(u => u.username === username);
        if (existing) {
            throw new Error(`Username "${username}" already exists.`);
        }

        const salt = crypto.randomBytes(16).toString('hex');
        const passwordHash = this.hashPassword(password, salt);

        // First user created is automatically Admin with 'default' WhatsApp session
        const isFirstUser = this.users.length === 0;
        const role = isFirstUser ? 'admin' : (options.role || 'user');
        const sessionId = isFirstUser ? 'default' : (options.sessionId || username);

        const newUser = {
            id: 'usr_' + crypto.randomBytes(8).toString('hex'),
            username,
            name: options.name || username,
            salt,
            passwordHash,
            role,
            sessionId,
            createdAt: new Date().toISOString()
        };

        this.users.push(newUser);
        this.saveUsers();

        const token = this.generateToken(newUser);
        return {
            token,
            user: this.sanitizeUser(newUser),
            isFirstUser
        };
    }

    login(rawUsername, password) {
        const username = String(rawUsername || '').trim().toLowerCase();
        const user = this.users.find(u => u.username === username);
        if (!user) {
            throw new Error('Invalid username or password.');
        }

        const computedHash = this.hashPassword(password, user.salt);
        const a = Buffer.from(computedHash, 'hex');
        const b = Buffer.from(user.passwordHash, 'hex');

        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            throw new Error('Invalid username or password.');
        }

        const token = this.generateToken(user);
        return {
            token,
            user: this.sanitizeUser(user)
        };
    }

    generateToken(user) {
        const token = 'gh_' + crypto.randomBytes(32).toString('hex');
        this.tokens[token] = {
            userId: user.id,
            username: user.username,
            role: user.role,
            sessionId: user.sessionId,
            createdAt: new Date().toISOString()
        };
        this.saveTokens();
        return token;
    }

    verifyToken(token) {
        if (!token || typeof token !== 'string') return null;
        const session = this.tokens[token];
        if (!session) return null;

        const user = this.users.find(u => u.id === session.userId);
        if (!user) {
            delete this.tokens[token];
            this.saveTokens();
            return null;
        }

        return this.sanitizeUser(user);
    }

    logout(token) {
        if (token && this.tokens[token]) {
            delete this.tokens[token];
            this.saveTokens();
            return true;
        }
        return false;
    }

    sanitizeUser(user) {
        return {
            id: user.id,
            username: user.username,
            name: user.name || user.username,
            role: user.role,
            sessionId: user.sessionId,
            createdAt: user.createdAt
        };
    }

    // Express middleware to protect API routes
    middleware() {
        return (req, res, next) => {
            // Check authorization header or token query/body
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

            const user = this.verifyToken(token);
            if (!user) {
                return res.status(401).json({
                    error: 'INVALID_TOKEN',
                    message: 'Session expired or invalid. Please sign in again.'
                });
            }

            req.authUser = user;
            next();
        };
    }
}

module.exports = new AuthManager();
