const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ProxyAgent } = require('undici');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));
app.disable('etag');
app.use((req, res, next) => {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    next();
});

const OLLAMA_URL = 'http://localhost:11434';
const GOOGLE_API_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const EXTERNAL_PROXY = 'http://10.88.202.78:50000';
const externalProxyAgent = new ProxyAgent(EXTERNAL_PROXY);
const GOOGLE_MODELS = [
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3-flash-preview'
];
const configPath = path.join(__dirname, 'config.txt');
const modelOptionDefaults = {
    temperature: '0.7',
    num_ctx: '4096',
    top_p: '0.9',
    top_k: '40',
    repeat_penalty: '1.1',
    seed: '-1',
    num_predict: '-1'
};

function loadAdminConfig() {
    const defaults = { admin_username: 'admin', admin_password: 'admin123' };
    try {
        return fs.readFileSync(configPath, 'utf8').split(/\r?\n/).reduce((config, line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return config;
            const separator = trimmed.indexOf('=');
            if (separator === -1) return config;
            const key = trimmed.slice(0, separator).trim();
            const value = trimmed.slice(separator + 1).trim();
            if (key in defaults && value) config[key] = value;
            return config;
        }, { ...defaults });
    } catch (err) {
        fs.writeFileSync(configPath, 'admin_username=admin\nadmin_password=admin123\n', 'utf8');
        return defaults;
    }
}

const adminConfig = loadAdminConfig();

const db = new sqlite3.Database('chatbox.db');
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function(err) { err ? rej(err) : res(this) }));
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (err, row) => err ? rej(err) : res(row)));
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (err, rows) => err ? rej(err) : res(rows)));

const hashPassword = (pwd) => crypto.createHash('sha256').update(pwd).digest('hex');
const clampNumber = (value, min, max, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback;
};
const clampInteger = (value, min, max, fallback) => Math.trunc(clampNumber(value, min, max, fallback));

async function initDB() {
    await dbRun(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password TEXT, role TEXT)`);
    await dbRun(`CREATE TABLE IF NOT EXISTS tokens (token TEXT PRIMARY KEY, user_id INTEGER)`);
    await dbRun(`CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT, model TEXT)`);
    try { await dbRun(`ALTER TABLE conversations ADD COLUMN model TEXT`); } catch (err) {}
    await dbRun(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, conv_id INTEGER, role TEXT, content TEXT)`);
    await dbRun(`CREATE TABLE IF NOT EXISTS user_settings (user_id INTEGER PRIMARY KEY, personal_prompt TEXT NOT NULL DEFAULT '')`);
    await dbRun(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`);
    await dbRun(`INSERT OR IGNORE INTO config (key, value) VALUES ('global_system_prompt', '你是一个有用的 AI 助手。')`);
    await dbRun(`INSERT OR IGNORE INTO config (key, value) VALUES ('external_api_url', '')`);
    await dbRun(`INSERT OR IGNORE INTO config (key, value) VALUES ('external_api_key', '')`);
    for (const [key, value] of Object.entries(modelOptionDefaults)) {
        await dbRun(`INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)`, [key, value]);
    }
    
    const adminHash = hashPassword(adminConfig.admin_password);
    await dbRun(`UPDATE users SET role = 'user' WHERE role = 'admin' AND username != ?`, [adminConfig.admin_username]);
    await dbRun(`INSERT OR IGNORE INTO users (username, password, role) VALUES (?, ?, 'admin')`, [adminConfig.admin_username, adminHash]);
    await dbRun(`UPDATE users SET password = ?, role = 'admin' WHERE username = ?`, [adminHash, adminConfig.admin_username]);
}
initDB();

async function authUser(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ detail: 'Unauthorized' });
    const token = auth.split(' ')[1];
    const user = await dbGet(`SELECT u.* FROM users u JOIN tokens t ON u.id = t.user_id WHERE t.token = ?`, [token]);
    if (!user) return res.status(401).json({ detail: 'Unauthorized' });
    req.user = user;
    next();
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.post('/api/register', async (req, res) => {
    try {
        await dbRun(`INSERT INTO users (username, password, role) VALUES (?, ?, 'user')`, [req.body.username, hashPassword(req.body.password)]);
        res.json({ msg: '注册成功' });
    } catch (err) {
        res.status(400).json({ detail: '用户名已存在' });
    }
});

app.post('/api/login', async (req, res) => {
    const user = await dbGet(`SELECT id, username, role FROM users WHERE username = ? AND password = ?`, [req.body.username, hashPassword(req.body.password)]);
    if (!user) return res.status(400).json({ detail: '账号或密码错误' });
    const token = crypto.randomBytes(32).toString('hex');
    await dbRun(`INSERT INTO tokens (token, user_id) VALUES (?, ?)`, [token, user.id]);
    res.json({ token, username: user.username, role: user.role });
});

app.get('/api/user/settings', authUser, async (req, res) => {
    const settings = await dbGet(`SELECT personal_prompt FROM user_settings WHERE user_id = ?`, [req.user.id]);
    res.json({ personal_prompt: settings?.personal_prompt || '' });
});

app.post('/api/user/settings', authUser, async (req, res) => {
    const personalPrompt = String(req.body.personal_prompt || '').slice(0, 10000);
    await dbRun(`INSERT INTO user_settings (user_id, personal_prompt) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET personal_prompt = excluded.personal_prompt`, [req.user.id, personalPrompt]);
    res.json({ msg: '个人提示词已保存' });
});

app.get('/api/models', authUser, async (req, res) => {
    let ollamaModels = [];
    try {
        const response = await fetch(`${OLLAMA_URL}/api/tags`);
        const data = await response.json();
        ollamaModels = data.models || [];
    } catch (err) {}
    try {
        const config = await dbAll(`SELECT key, value FROM config WHERE key IN ('external_api_url', 'external_api_key', 'external_models')`);
        const externalSettings = config.reduce((values, item) => ({ ...values, [item.key]: item.value }), {});
        const configuredModels = (externalSettings.external_models || GOOGLE_MODELS.join(','))
            .split(',').map(model => model.trim()).filter(Boolean);
        const externalEnabled = Boolean(externalSettings.external_api_url || externalSettings.external_api_key);
        const externalModels = externalEnabled ? configuredModels.map(name => ({ name, external: true })) : [];
        res.json({ models: [...ollamaModels, ...externalModels] });
    } catch (err) { res.json({ models: ollamaModels }); }
});

app.get('/api/conversations', authUser, async (req, res) => {
    const convs = await dbAll(`SELECT * FROM conversations WHERE user_id = ? ORDER BY id DESC`, [req.user.id]);
    res.json(convs);
});

app.post('/api/conversations', authUser, async (req, res) => {
    const model = String(req.body.model || '').slice(0, 200);
    const result = await dbRun(`INSERT INTO conversations (user_id, title, model) VALUES (?, '新对话', ?)`, [req.user.id, model]);
    res.json({ id: result.lastID, title: '新对话', model });
});

app.delete('/api/conversations/:id', authUser, async (req, res) => {
    const conversation = await dbGet(`SELECT id FROM conversations WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
    if (!conversation) return res.status(404).json({ detail: 'Conversation not found' });
    await dbRun(`DELETE FROM messages WHERE conv_id = ?`, [req.params.id]);
    await dbRun(`DELETE FROM conversations WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
    res.json({ msg: '对话已删除' });
});

app.get('/api/conversations/:id/messages', authUser, async (req, res) => {
    const convId = req.params.id;
    const exists = await dbGet(`SELECT 1 FROM conversations WHERE id = ? AND user_id = ?`, [convId, req.user.id]);
    if (!exists) return res.status(403).json({ detail: 'Forbidden' });
    const msgs = await dbAll(`SELECT role, content FROM messages WHERE conv_id = ? ORDER BY id ASC`, [convId]);
    res.json(msgs);
});

app.post('/api/chat', authUser, async (req, res) => {
    const { conv_id, model, message, regenerate } = req.body;
    const isRegeneration = regenerate === true;
    const exists = await dbGet(`SELECT 1 FROM conversations WHERE id = ? AND user_id = ?`, [conv_id, req.user.id]);
    if (!exists) return res.status(403).json({ detail: 'Forbidden' });
    await dbRun(`UPDATE conversations SET model = ? WHERE id = ? AND user_id = ?`, [String(model || '').slice(0, 200), conv_id, req.user.id]);

    const msgCount = (await dbGet(`SELECT COUNT(*) as count FROM messages WHERE conv_id = ?`, [conv_id])).count;
    if (isRegeneration) {
        const lastMessage = await dbGet(`SELECT id, role FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT 1`, [conv_id]);
        if (!lastMessage || lastMessage.role !== 'assistant') {
            return res.status(400).json({ detail: 'No assistant message to regenerate' });
        }
        await dbRun(`DELETE FROM messages WHERE id = ?`, [lastMessage.id]);
    } else {
        if (msgCount === 0) {
            await dbRun(`UPDATE conversations SET title = ? WHERE id = ?`, [message.substring(0, 15), conv_id]);
        }
        await dbRun(`INSERT INTO messages (conv_id, role, content) VALUES (?, 'user', ?)`, [conv_id, message]);
    }

    const history = await dbAll(`SELECT role, content FROM messages WHERE conv_id = ? ORDER BY id ASC`, [conv_id]);
    const userSettings = await dbGet(`SELECT personal_prompt FROM user_settings WHERE user_id = ?`, [req.user.id]);
    const config = await dbAll(`SELECT key, value FROM config WHERE key IN ('global_system_prompt', 'external_api_url', 'external_api_key', 'external_models', ${Object.keys(modelOptionDefaults).map(() => '?').join(', ')})`, Object.keys(modelOptionDefaults));
    const settings = config.reduce((values, item) => ({ ...values, [item.key]: item.value }), {});
    const options = {
        temperature: clampNumber(settings.temperature, 0, 2, 0.7),
        num_ctx: clampInteger(settings.num_ctx, 128, 131072, 4096),
        top_p: clampNumber(settings.top_p, 0, 1, 0.9),
        top_k: clampInteger(settings.top_k, 0, 1000, 40),
        repeat_penalty: clampNumber(settings.repeat_penalty, 0, 3, 1.1),
        seed: clampInteger(settings.seed, -1, 2147483647, -1),
        num_predict: clampInteger(settings.num_predict, -1, 131072, -1)
    };
    
    const systemMessages = [];
    if (settings.global_system_prompt) systemMessages.push({ role: 'system', content: settings.global_system_prompt });
    if (userSettings?.personal_prompt) systemMessages.push({ role: 'system', content: userSettings.personal_prompt });
    const payload = { model, messages: [...systemMessages, ...history], options };

    try {
            const configuredExternalModels = (settings.external_models || GOOGLE_MODELS.join(','))
                .split(',').map(item => item.trim()).filter(Boolean);
            const isExternalModel = Boolean((settings.external_api_url || settings.external_api_key) && configuredExternalModels.includes(model));
            const externalUrl = String(settings.external_api_url || GOOGLE_API_URL).trim().replace(/\/$/, '');
            const targetUrl = isExternalModel
                ? `${externalUrl}${externalUrl.endsWith('/chat/completions') ? '' : '/chat/completions'}`
                : `${OLLAMA_URL}/api/chat`;
            const requestPayload = isExternalModel
                ? { model, messages: payload.messages, temperature: options.temperature, top_p: options.top_p, max_tokens: options.num_predict > 0 ? options.num_predict : undefined, stream: true }
                : payload;
            const requestHeaders = { 'Content-Type': 'application/json' };
            if (isExternalModel && settings.external_api_key) {
                requestHeaders.Authorization = `Bearer ${settings.external_api_key}`;
            }
            const ollamaRes = await fetch(targetUrl, {
            method: 'POST',
                headers: requestHeaders,
                body: JSON.stringify(requestPayload),
                ...(isExternalModel ? { dispatcher: externalProxyAgent } : {})
        });
            if (!ollamaRes.ok) {
                const errorBody = await ollamaRes.text();
                throw new Error(`External API returned ${ollamaRes.status}: ${errorBody.slice(0, 300)}`);
            }

        res.setHeader('Content-Type', 'application/x-ndjson');
        let fullReply = '';
        let streamBuffer = '';
        const streamDecoder = new TextDecoder('utf-8');
        const processStreamLine = (line) => {
            const content = isExternalModel
                ? (() => {
                    const data = line.startsWith('data:') ? line.slice(5).trim() : '';
                    if (!data || data === '[DONE]') return '';
                    try { return JSON.parse(data).choices?.[0]?.delta?.content || ''; } catch (e) { return ''; }
                })()
                : (() => {
                    try { return JSON.parse(line).message?.content || ''; } catch (e) { return ''; }
                })();
            if (content) {
                res.write(JSON.stringify({ message: { content } }) + '\n');
                fullReply += content;
            } else if (!isExternalModel && line.trim()) {
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.done) res.write(line + '\n');
                } catch (e) {}
            }
        };
        for await (const chunk of ollamaRes.body) {
            streamBuffer += streamDecoder.decode(chunk, { stream: true });
            const lines = streamBuffer.split('\n');
            streamBuffer = lines.pop() || '';
            for (const line of lines) processStreamLine(line.trimEnd());
        }
        streamBuffer += streamDecoder.decode();
        if (streamBuffer.trim()) processStreamLine(streamBuffer.trimEnd());
        res.end();
        await dbRun(`INSERT INTO messages (conv_id, role, content) VALUES (?, 'assistant', ?)`, [conv_id, fullReply]);
    } catch (err) {
        console.error('Chat request failed:', err.message);
        if (!res.headersSent) res.status(502).json({ detail: err.message || 'External API connection error' });
    }
});

app.get('/api/admin/settings', authUser, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ detail: 'Forbidden' });
    const config = await dbAll(`SELECT * FROM config`);
    const settings = config.reduce((acc, curr) => ({ ...acc, [curr.key]: curr.value }), {});
    res.json(settings);
});

app.post('/api/admin/settings', authUser, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ detail: 'Forbidden' });
    await dbRun(`UPDATE config SET value = ? WHERE key = 'global_system_prompt'`, [String(req.body.global_system_prompt || '')]);
    for (const key of Object.keys(modelOptionDefaults)) {
        if (req.body[key] !== undefined) {
            await dbRun(`UPDATE config SET value = ? WHERE key = ?`, [String(req.body[key]), key]);
        }
    }
    for (const key of ['external_api_url', 'external_api_key', 'external_models']) {
        if (req.body[key] !== undefined) {
            await dbRun(`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, String(req.body[key] || '')]);
        }
    }
    res.json({ msg: '已保存全局设置' });
});

const port = process.env.PORT || 8000;
app.listen(port, () => console.log(`Server is running on http://localhost:${port}`));