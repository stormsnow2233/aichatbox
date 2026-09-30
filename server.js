const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { ProxyAgent } = require('undici');

const app = express();
const scrypt = promisify(crypto.scrypt);
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
let externalProxyUrl = '';
let externalProxyAgent;
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

const hashPassword = async (password) => {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await scrypt(password, salt, 64);
    return `scrypt$${salt}$${hash.toString('hex')}`;
};
const verifyPassword = async (password, encoded) => {
    const parts = String(encoded || '').split('$');
    if (parts.length === 3 && parts[0] === 'scrypt' && /^[a-f0-9]{32}$/i.test(parts[1]) && /^[a-f0-9]{128}$/i.test(parts[2])) {
        const hash = await scrypt(password, parts[1], 64);
        return crypto.timingSafeEqual(hash, Buffer.from(parts[2], 'hex'));
    }
    if (/^[a-f0-9]{64}$/i.test(encoded || '')) {
        const legacyHash = Buffer.from(crypto.createHash('sha256').update(password).digest('hex'), 'hex');
        return crypto.timingSafeEqual(legacyHash, Buffer.from(encoded, 'hex'));
    }
    return false;
};
const clampNumber = (value, min, max, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback;
};
const clampInteger = (value, min, max, fallback) => Math.trunc(clampNumber(value, min, max, fallback));

async function initDB() {
    await dbRun(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password TEXT, role TEXT, external_id TEXT)`);
    try { await dbRun(`ALTER TABLE users ADD COLUMN external_id TEXT`); } catch (err) {}
    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_external_id ON users (external_id)`);
    await dbRun(`CREATE TABLE IF NOT EXISTS tokens (token TEXT PRIMARY KEY, user_id INTEGER)`);
    await dbRun(`CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT, model TEXT)`);
    try { await dbRun(`ALTER TABLE conversations ADD COLUMN model TEXT`); } catch (err) {}
    await dbRun(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, conv_id INTEGER, role TEXT, content TEXT)`);
    await dbRun(`CREATE TABLE IF NOT EXISTS user_settings (user_id INTEGER PRIMARY KEY, personal_prompt TEXT NOT NULL DEFAULT '')`);
    try { await dbRun(`ALTER TABLE user_settings ADD COLUMN enabled_models TEXT`); } catch (err) {}
    await dbRun(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`);
    await dbRun(`INSERT OR IGNORE INTO config (key, value) VALUES ('global_system_prompt', '你是一个有用的 AI 助手。')`);
    await dbRun(`INSERT OR IGNORE INTO config (key, value) VALUES ('external_api_url', '')`);
    await dbRun(`INSERT OR IGNORE INTO config (key, value) VALUES ('external_api_key', '')`);
    await dbRun(`INSERT OR IGNORE INTO config (key, value) VALUES ('proxy_url', '')`);
    for (const [key, value] of Object.entries(modelOptionDefaults)) {
        await dbRun(`INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)`, [key, value]);
    }
    
    const adminHash = await hashPassword(adminConfig.admin_password);
    await dbRun(`UPDATE users SET role = 'user' WHERE role = 'admin' AND username != ?`, [adminConfig.admin_username]);
    await dbRun(`INSERT OR IGNORE INTO users (username, password, role) VALUES (?, ?, 'admin')`, [adminConfig.admin_username, adminHash]);
    await dbRun(`UPDATE users SET password = ?, role = 'admin' WHERE username = ?`, [adminHash, adminConfig.admin_username]);
}
const dbReady = initDB();

async function authUser(req, res, next) {
    await dbReady;
    const auth = req.headers.authorization;
    if (auth) {
        if (!auth.startsWith('Bearer ')) return res.status(401).json({ detail: 'Unauthorized' });
        const token = auth.split(' ')[1];
        const user = await dbGet(`SELECT u.* FROM users u JOIN tokens t ON u.id = t.user_id WHERE t.token = ? AND u.role = 'admin'`, [token]);
        if (!user) return res.status(401).json({ detail: 'Unauthorized' });
        req.user = user;
        return next();
    }

    let externalId = '';
    try {
        externalId = typeof req.headers['x-user-id'] === 'string' ? decodeURIComponent(req.headers['x-user-id']) : '';
    } catch (err) {
        return res.status(400).json({ detail: 'userid 参数格式无效' });
    }
    if (!externalId.trim() || externalId.length > 128 || /[\u0000-\u001f\u007f]/.test(externalId)) {
        return res.status(400).json({ detail: '请使用包含有效 userid 参数的网址打开 Chatbox' });
    }
    const username = `injected_${crypto.createHash('sha256').update(externalId).digest('hex')}`;
    await dbRun(`INSERT OR IGNORE INTO users (username, password, role, external_id) VALUES (?, NULL, 'user', ?)`, [username, externalId]);
    req.user = await dbGet(`SELECT * FROM users WHERE external_id = ?`, [externalId]);
    if (!req.user) return res.status(500).json({ detail: '创建用户失败' });
    return next();
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.post('/api/login', async (req, res) => {
    await dbReady;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (typeof body.username !== 'string' || typeof body.password !== 'string' || !body.username.trim() || !body.password) {
        return res.status(400).json({ detail: '请输入完整的账号和密码' });
    }
    const user = await dbGet(`SELECT id, username, password, role FROM users WHERE username = ?`, [body.username.trim()]);
    if (!user || user.role !== 'admin' || !await verifyPassword(body.password, user.password)) {
        return res.status(400).json({ detail: '管理员账号或密码错误' });
    }
    if (!String(user.password).startsWith('scrypt$')) {
        await dbRun(`UPDATE users SET password = ? WHERE id = ?`, [await hashPassword(body.password), user.id]);
    }
    const token = crypto.randomBytes(32).toString('hex');
    await dbRun(`INSERT INTO tokens (token, user_id) VALUES (?, ?)`, [token, user.id]);
    res.json({ token, username: user.username, role: user.role });
});

app.get('/api/user/settings', authUser, async (req, res) => {
    const settings = await dbGet(`SELECT personal_prompt, enabled_models FROM user_settings WHERE user_id = ?`, [req.user.id]);
    let enabledModels = null;
    if (settings?.enabled_models) {
        try { enabledModels = JSON.parse(settings.enabled_models); } catch (err) { enabledModels = null; }
    }
    res.json({ personal_prompt: settings?.personal_prompt || '', enabled_models: enabledModels });
});

app.post('/api/user/settings', authUser, async (req, res) => {
    const personalPrompt = String(req.body.personal_prompt || '').slice(0, 10000);
    await dbRun(`INSERT INTO user_settings (user_id, personal_prompt) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET personal_prompt = excluded.personal_prompt`, [req.user.id, personalPrompt]);
    res.json({ msg: '个人提示词已保存' });
});

app.post('/api/user/models', authUser, async (req, res) => {
    const requestedModels = Array.isArray(req.body.models) ? req.body.models.map(String) : [];
    const validModels = new Set((await getModelCatalog()).map(model => model.name));
    const enabledModels = [...new Set(requestedModels.filter(model => validModels.has(model)))];
    await dbRun(`INSERT INTO user_settings (user_id, enabled_models) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET enabled_models = excluded.enabled_models`, [req.user.id, JSON.stringify(enabledModels)]);
    res.json({ msg: '模型偏好已保存', enabled_models: enabledModels });
});

function normalizeProvider(provider) {
    const type = provider.type === 'anthropic' ? 'anthropic' : 'openai';
    const defaultUrl = type === 'anthropic' ? 'https://api.anthropic.com/v1' : '';
    return {
        id: String(provider.id || '').slice(0, 80),
        name: String(provider.name || (type === 'anthropic' ? 'Claude' : 'OpenAI 兼容')).slice(0, 80),
        type,
        base_url: String(provider.base_url || defaultUrl).trim().replace(/\/$/, '').slice(0, 500),
        api_key: String(provider.api_key || '').trim().slice(0, 1000),
        models: String(provider.models || '').slice(0, 10000)
    };
}

function parseProviderModels(provider) {
    return provider.models.split(/[\n,，]/).map(model => model.trim()).filter(Boolean);
}

const nonChatModelPattern = /(?:^|[-_/.])(embedding|embed|rerank|re-rank|search|web-search|websearch|image|img|diffusion|flux|dall[-_]?e|imagen|cogview|seedream|kolors|tts|asr|whisper|transcription|speech|audio|video|ocr|moderation|classifier)(?:$|[-_/.])/i;
const isChatModel = name => !nonChatModelPattern.test(name);

function providerEndpoint(baseUrl, endpoint) {
    const base = String(baseUrl || '').trim().replace(/\/$/, '');
    if (!base) throw new Error('请填写 API 地址');
    if (base.endsWith(endpoint)) return base;
    if (base.endsWith('/v1') && endpoint.startsWith('/v1/')) return `${base}${endpoint.slice(3)}`;
    return `${base}${endpoint}`;
}

function getExternalProxyAgent(proxyUrl) {
    const url = String(proxyUrl || '').trim();
    if (url !== externalProxyUrl) {
        const previousAgent = externalProxyAgent;
        externalProxyUrl = url;
        externalProxyAgent = url ? new ProxyAgent(url) : undefined;
        if (previousAgent) previousAgent.close().catch(() => {});
    }
    return externalProxyAgent;
}

async function fetchProviderModels(provider, proxyUrl) {
    const url = providerEndpoint(provider.base_url, provider.type === 'anthropic' ? '/v1/models' : '/models');
    const headers = provider.type === 'anthropic'
        ? { 'x-api-key': provider.api_key, 'anthropic-version': '2023-06-01' }
        : { Authorization: `Bearer ${provider.api_key}` };
    const dispatcher = getExternalProxyAgent(proxyUrl);
    const response = await fetch(url, { headers, ...(dispatcher ? { dispatcher } : {}) });
    const body = await response.text();
    if (!response.ok) throw new Error(`模型列表请求失败 (${response.status}): ${body.slice(0, 300)}`);
    let data;
    try {
        data = JSON.parse(body);
    } catch (err) {
        const contentType = response.headers.get('content-type') || '未知类型';
        throw new Error(`模型接口返回的不是 JSON（${contentType}）。请填写 API 根地址，而不是服务商网页地址，并确认模型列表接口可用。`);
    }
    const models = (data.data || data.models || []).map(item => typeof item === 'string' ? item : item.id || item.name).filter(Boolean);
    if (!models.length) throw new Error('接口未返回模型列表；请手动填写该服务商支持的模型 ID。');
    return models;
}

async function getModelCatalog() {
    let ollamaModels = [];
    try {
        const response = await fetch(`${OLLAMA_URL}/api/tags`);
        const data = await response.json();
        ollamaModels = (data.models || []).map(model => ({
            name: model.name,
            label: model.name,
            provider: 'Ollama',
            default_enabled: true
        }));
    } catch (err) {}
    const config = await dbAll(`SELECT key, value FROM config WHERE key IN ('external_providers', 'external_api_url', 'external_api_key', 'external_models')`);
    const externalSettings = config.reduce((values, item) => ({ ...values, [item.key]: item.value }), {});
    let providers = [];
    if (externalSettings.external_providers) {
        try { providers = JSON.parse(externalSettings.external_providers).map(normalizeProvider); } catch (err) {}
    } else if (externalSettings.external_api_url || externalSettings.external_api_key) {
        providers = [normalizeProvider({
            id: 'legacy-google', name: 'Google AI', type: 'openai',
            base_url: externalSettings.external_api_url || GOOGLE_API_URL,
            api_key: externalSettings.external_api_key,
            models: externalSettings.external_models || GOOGLE_MODELS.join(',')
        })];
    }
    const externalModels = providers.filter(provider => provider.base_url && provider.api_key).flatMap(provider => parseProviderModels(provider)
        .filter(isChatModel)
        .map(name => ({
            name: `ext:${provider.id}:${name}`,
            label: name,
            provider: provider.name,
            external: true,
            default_enabled: /^gemini[-/.]/i.test(name)
        })));
    return [...ollamaModels, ...externalModels].filter(model => model.name && isChatModel(model.name));
}

app.get('/api/models/catalog', authUser, async (req, res) => {
    try { res.json({ models: await getModelCatalog() }); }
    catch (err) { res.status(500).json({ detail: '读取模型目录失败' }); }
});

app.get('/api/models', authUser, async (req, res) => {
    try {
        const catalog = await getModelCatalog();
        const settings = await dbGet(`SELECT enabled_models FROM user_settings WHERE user_id = ?`, [req.user.id]);
        let enabledModels = null;
        if (settings?.enabled_models) {
            try { enabledModels = JSON.parse(settings.enabled_models); } catch (err) {}
        }
        const visibleModels = enabledModels === null
            ? catalog.filter(model => model.default_enabled)
            : catalog.filter(model => enabledModels.includes(model.name));
        res.json({ models: visibleModels });
    } catch (err) { res.json({ models: [] }); }
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
    const config = await dbAll(`SELECT key, value FROM config WHERE key IN ('global_system_prompt', 'external_providers', 'external_api_url', 'external_api_key', 'external_models', 'proxy_url', ${Object.keys(modelOptionDefaults).map(() => '?').join(', ')})`, Object.keys(modelOptionDefaults));
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
        let providers = [];
        if (settings.external_providers) {
            try { providers = JSON.parse(settings.external_providers).map(normalizeProvider); } catch (err) {}
        } else if (settings.external_api_url || settings.external_api_key) {
            providers = [normalizeProvider({
                id: 'legacy-google', name: 'Google AI', type: 'openai',
                base_url: settings.external_api_url || GOOGLE_API_URL,
                api_key: settings.external_api_key,
                models: settings.external_models || GOOGLE_MODELS.join(',')
            })];
        }
        const externalPrefix = 'ext:';
        const isExternalModel = String(model || '').startsWith(externalPrefix);
        const externalConfig = isExternalModel
            ? (() => {
                const separator = String(model).indexOf(':', externalPrefix.length);
                const providerId = separator < 0 ? '' : String(model).slice(externalPrefix.length, separator);
                const modelName = separator < 0 ? '' : String(model).slice(separator + 1);
                const provider = providers.find(item => item.id === providerId);
                if (!provider || !parseProviderModels(provider).includes(modelName)) throw new Error('该外部模型配置已失效，请刷新模型列表');
                return { provider, modelName };
            })()
            : null;
        const provider = externalConfig?.provider;
        const modelName = externalConfig?.modelName || model;
        const isAnthropic = provider?.type === 'anthropic';
        const targetUrl = !provider
            ? `${OLLAMA_URL}/api/chat`
            : providerEndpoint(provider.base_url, isAnthropic ? '/v1/messages' : '/chat/completions');
        const externalMessages = payload.messages.filter(item => item.role !== 'system');
        const requestPayload = !provider ? payload : isAnthropic
            ? {
                model: modelName,
                system: payload.messages.filter(item => item.role === 'system').map(item => item.content).join('\n\n') || undefined,
                messages: externalMessages,
                temperature: options.temperature,
                max_tokens: options.num_predict > 0 ? options.num_predict : 4096,
                stream: true
            }
            : {
                model: modelName,
                messages: payload.messages,
                temperature: options.temperature,
                top_p: options.top_p,
                max_tokens: options.num_predict > 0 ? options.num_predict : undefined,
                stream: true
            };
        const requestHeaders = { 'Content-Type': 'application/json' };
        if (provider && isAnthropic) {
            requestHeaders['x-api-key'] = provider.api_key;
            requestHeaders['anthropic-version'] = '2023-06-01';
        } else if (provider) {
            requestHeaders.Authorization = `Bearer ${provider.api_key}`;
        }
        const dispatcher = provider ? getExternalProxyAgent(settings.proxy_url) : undefined;
        const ollamaRes = await fetch(targetUrl, {
            method: 'POST',
            headers: requestHeaders,
            body: JSON.stringify(requestPayload),
            ...(provider && dispatcher ? { dispatcher } : {})
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
            const content = provider
                ? (() => {
                    const data = line.startsWith('data:') ? line.slice(5).trim() : '';
                    if (!data || data === '[DONE]') return '';
                    try {
                        const event = JSON.parse(data);
                        return isAnthropic ? (event.type === 'content_block_delta' ? event.delta?.text || '' : '') : event.choices?.[0]?.delta?.content || '';
                    } catch (e) { return ''; }
                })()
                : (() => {
                    try { return JSON.parse(line).message?.content || ''; } catch (e) { return ''; }
                })();
            if (content) {
                res.write(JSON.stringify({ message: { content } }) + '\n');
                fullReply += content;
            } else if (!provider && line.trim()) {
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

app.post('/api/admin/models', authUser, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ detail: 'Forbidden' });
    try {
        const provider = normalizeProvider(req.body || {});
        if (!provider.api_key) return res.status(400).json({ detail: '请先填写 API Key' });
        const models = await fetchProviderModels(provider, req.body.proxy_url);
        res.json({ models });
    } catch (err) {
        res.status(502).json({ detail: err.message || '获取模型列表失败' });
    }
});

app.post('/api/admin/settings', authUser, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ detail: 'Forbidden' });
    await dbRun(`UPDATE config SET value = ? WHERE key = 'global_system_prompt'`, [String(req.body.global_system_prompt || '')]);
    await dbRun(`INSERT INTO config (key, value) VALUES ('proxy_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(req.body.proxy_url || '').trim().slice(0, 500)]);
    for (const key of Object.keys(modelOptionDefaults)) {
        if (req.body[key] !== undefined) {
            await dbRun(`UPDATE config SET value = ? WHERE key = ?`, [String(req.body[key]), key]);
        }
    }
    if (req.body.providers !== undefined) {
        const providers = Array.isArray(req.body.providers) ? req.body.providers.map(normalizeProvider) : [];
        await dbRun(`INSERT INTO config (key, value) VALUES ('external_providers', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify(providers)]);
    }
    res.json({ msg: '已保存全局设置' });
});

const port = process.env.PORT || 8000;
app.listen(port, () => console.log(`Server is running on http://localhost:${port}`));