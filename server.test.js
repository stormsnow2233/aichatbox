const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const projectRoot = __dirname;

async function getFreePort() {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
}

async function readJson(response) {
    return response.json();
}

test('page inline scripts parse successfully', async () => {
    for (const fileName of ['index.html', 'admin.html']) {
        const html = await fs.readFile(path.join(projectRoot, fileName), 'utf8');
        const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
            .filter(match => !/\bsrc\s*=/.test(match[1]));
        assert.ok(scripts.length, `${fileName} should contain an inline script`);
        for (const script of scripts) new vm.Script(script[2], { filename: fileName });
    }
});

test('userid pages enforce the intended UI boundaries', async () => {
    const indexHtml = await fs.readFile(path.join(projectRoot, 'index.html'), 'utf8');
    const adminHtml = await fs.readFile(path.join(projectRoot, 'admin.html'), 'utf8');

    assert.match(indexHtml, /<h1 id="auth-title">拒绝访问<\/h1>/);
    assert.doesNotMatch(indexHtml, /\/api\/(?:login|register)|登录工作台|创建账号/);
    assert.match(indexHtml, /v-if="userRole === 'admin'"\s+@click="openModelSettings"/);
    assert.doesNotMatch(adminHtml, /111111/);
    assert.match(adminHtml, /用户总数/);
    assert.match(adminHtml, /角色分布/);
    assert.match(adminHtml, /累计对话数/);
    assert.match(adminHtml, /userStats\.conversations/);
    assert.match(adminHtml, /class="admin-tab-rail"/);
    assert.match(adminHtml, /v-show="activeTab === 'settings'"/);
    assert.match(adminHtml, /v-show="activeTab === 'users'"/);
    assert.equal((adminHtml.match(/class="admin-tab-panel/g) || []).length, 2);
    assert.match(adminHtml, /刷新数据/);
    assert.doesNotMatch(adminHtml, /mode="out-in"/);
    assert.match(adminHtml, /class="otp-char">\*<\/span>/);

    const tableHeader = adminHtml.match(/<thead[\s\S]*?<\/thead>/)?.[0];
    assert.ok(tableHeader);
    assert.ok(tableHeader.indexOf('User ID') < tableHeader.indexOf('最后 IP'));
    assert.ok(tableHeader.indexOf('最后 IP') < tableHeader.indexOf('最后活动时间'));
    assert.doesNotMatch(tableHeader, /<th[^>]*>\s*ID\s*<\/th>/i);
});

test('userid selects an isolated account and admin APIs require verification', { timeout: 30000 }, async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aichatbox-test-'));
    const port = await getFreePort();
    const child = spawn(process.execPath, [path.join(projectRoot, 'server.js')], {
        cwd: tempDir,
        env: { ...process.env, PORT: String(port), DB_PATH: path.join(tempDir, 'test.db') },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });

    const baseUrl = `http://127.0.0.1:${port}`;
    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 15000);
            child.on('exit', code => {
                clearTimeout(timeout);
                reject(new Error(`Server exited (${code}): ${output}`));
            });
            child.stdout.on('data', chunk => {
                if (String(chunk).includes('Server is running')) {
                    clearTimeout(timeout);
                    resolve();
                }
            });
        });

        const deniedHome = await fetch(baseUrl);
        assert.equal(deniedHome.status, 403);
        assert.match(await deniedHome.text(), /<h1>拒绝访问<\/h1>/);

        const userHome = await fetch(`${baseUrl}/?userid=1`);
        assert.equal(userHome.status, 200);
        const deniedAdminPage = await fetch(`${baseUrl}/admin.html?userid=1`);
        assert.equal(deniedAdminPage.status, 403);

        const userHeaders = { Authorization: 'Bearer 1' };
        const userConversations = await fetch(`${baseUrl}/api/conversations`, { headers: userHeaders });
        assert.deepEqual(await readJson(userConversations), []);
        const createdConversation = await fetch(`${baseUrl}/api/conversations`, {
            method: 'POST',
            headers: { ...userHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'test-model' })
        });
        assert.equal(createdConversation.status, 200);
        const conversation = await readJson(createdConversation);
        const hiddenModelChat = await fetch(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: { ...userHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ conv_id: conversation.id, model: 'test-model', message: 'test' })
        });
        assert.equal(hiddenModelChat.status, 403);

        const otherUserConversations = await fetch(`${baseUrl}/api/conversations`, {
            headers: { Authorization: 'Bearer 2' }
        });
        assert.deepEqual(await readJson(otherUserConversations), []);

        const deniedAdmin = await fetch(`${baseUrl}/api/admin/settings`, { headers: userHeaders });
        assert.equal(deniedAdmin.status, 403);

        const adminHeaders = { Authorization: 'Bearer admin' };
        const adminSettings = await fetch(`${baseUrl}/api/admin/settings`, { headers: adminHeaders });
        assert.equal(adminSettings.status, 403);

        const wrongCode = await fetch(`${baseUrl}/api/admin/verify_code`, {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: '000000' })
        });
        assert.equal(wrongCode.status, 400);

        const verified = await fetch(`${baseUrl}/api/admin/verify_code`, {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: '111111' })
        });
        assert.equal(verified.status, 200);
        const verification = await readJson(verified);
        assert.ok(verification.verification_token);

        const authorizedSettings = await fetch(`${baseUrl}/api/admin/settings`, {
            headers: { ...adminHeaders, 'X-Admin-Verification': verification.verification_token }
        });
        assert.equal(authorizedSettings.status, 200);
        const settings = await readJson(authorizedSettings);
        assert.equal(settings.admin_access_code, undefined);

        const users = await fetch(`${baseUrl}/api/admin/users`, {
            headers: { ...adminHeaders, 'X-Admin-Verification': verification.verification_token }
        });
        const listedUsers = await readJson(users);
        const listedAccount = listedUsers.find(user => user.username === '1');
        assert.ok(listedAccount && listedAccount.last_ip);
        assert.ok(listedAccount.conv_count > 0);
        assert.ok(listedUsers.some(user => user.username === '2'));
        assert.ok(listedUsers.some(user => user.username === 'admin' && user.role === 'admin'));
        assert.ok(listedUsers.every(user => Number.isFinite(user.conv_count)));
    } finally {
        child.kill();
        if (child.exitCode === null) await once(child, 'exit');
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});
