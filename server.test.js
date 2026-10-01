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

test('registration, login, authorization, and logout use real sessions', { timeout: 30000 }, async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aichatbox-test-'));
    const port = await getFreePort();
    const configPath = path.join(tempDir, 'config.txt');
    await fs.writeFile(configPath, 'admin_username=admin\nadmin_password=admin123\n', 'utf8');
    const child = spawn(process.execPath, [path.join(projectRoot, 'server.js')], {
        cwd: tempDir,
        env: { ...process.env, PORT: String(port), DB_PATH: path.join(tempDir, 'test.db'), CONFIG_PATH: configPath },
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

        const forgedAdmin = await fetch(`${baseUrl}/api/admin/settings`, {
            headers: { Authorization: 'Bearer admin' }
        });
        assert.equal(forgedAdmin.status, 401);

        const registered = await fetch(`${baseUrl}/api/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'alice', password: 'correct-horse-1' })
        });
        assert.equal(registered.status, 201);
        const registration = await readJson(registered);
        assert.ok(registration.token);
        assert.equal(registration.role, 'user');

        const duplicate = await fetch(`${baseUrl}/api/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'alice', password: 'correct-horse-1' })
        });
        assert.equal(duplicate.status, 409);

        const deniedAdmin = await fetch(`${baseUrl}/api/admin/settings`, {
            headers: { Authorization: `Bearer ${registration.token}` }
        });
        assert.equal(deniedAdmin.status, 403);

        const adminLogin = await fetch(`${baseUrl}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'admin123' })
        });
        assert.equal(adminLogin.status, 200);
        const adminSession = await readJson(adminLogin);
        assert.equal(adminSession.role, 'admin');
        assert.ok(adminSession.token);

        const adminSettings = await fetch(`${baseUrl}/api/admin/settings`, {
            headers: { Authorization: `Bearer ${adminSession.token}` }
        });
        assert.equal(adminSettings.status, 403);

        const wrongCode = await fetch(`${baseUrl}/api/admin/verify_code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminSession.token}` },
            body: JSON.stringify({ code: '000000' })
        });
        assert.equal(wrongCode.status, 400);

        const verified = await fetch(`${baseUrl}/api/admin/verify_code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminSession.token}` },
            body: JSON.stringify({ code: '111111' })
        });
        assert.equal(verified.status, 200);

        const authorizedSettings = await fetch(`${baseUrl}/api/admin/settings`, {
            headers: { Authorization: `Bearer ${adminSession.token}` }
        });
        assert.equal(authorizedSettings.status, 200);

        const logout = await fetch(`${baseUrl}/api/logout`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${adminSession.token}` }
        });
        assert.equal(logout.status, 200);
        const expiredSession = await fetch(`${baseUrl}/api/admin/settings`, {
            headers: { Authorization: `Bearer ${adminSession.token}` }
        });
        assert.equal(expiredSession.status, 401);
    } finally {
        child.kill();
        if (child.exitCode === null) await once(child, 'exit');
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});
