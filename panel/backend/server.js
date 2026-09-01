const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const express = require('express');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const Rcon = require('node-rcon');

const PANEL_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PANEL_DIR, '..');
const MINECRAFT_DIR = process.env.MINECRAFT_DIR || path.join(REPO_ROOT, 'server');
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(PANEL_DIR, 'frontend', 'dist');
const DATA_FILE = process.env.DATA_FILE || path.join(PANEL_DIR, 'backend', '.panel-users.json');
const PORT = Number(process.env.PANEL_PORT || 8787);
const HOST = process.env.PANEL_HOST || '127.0.0.1';
const JAVA_HOME = process.env.JAVA_HOME || '';
const JAVA_COMMAND = JAVA_HOME ? path.join(JAVA_HOME, 'bin', 'java') : 'java';
const MINECRAFT_HOST = process.env.MINECRAFT_HOST || '';
const MINECRAFT_CONTAINER = process.env.MINECRAFT_CONTAINER || 'minecraft';
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const LOG_FILE = process.env.LOG_FILE || path.join(MINECRAFT_DIR, 'logs', 'latest.log');
const BACKUP_DIR = path.join(MINECRAFT_DIR, 'backups');
const BACKUP_WARNING_SECONDS = Number(process.env.BACKUP_WARNING_SECONDS || 10);
const METRICS_INTERVAL_MS = Number(process.env.METRICS_INTERVAL_MS || 3000);
const METRICS_WINDOW_MS = Number(process.env.METRICS_WINDOW_MS || 5 * 60 * 1000);
const SESSION_TTL = 24 * 60 * 60 * 1000;
const FEATURE_KEYS = ['server.control', 'server.console', 'server.metrics', 'server.rcon', 'server.backups', 'users.manage'];
const COMMAND_CATALOG = [
    { id: 'list', label: 'List players', permission: 'server.rcon', command: 'list', fields: [] },
    { id: 'say', label: 'Broadcast message', permission: 'server.console', template: 'say {message}', fields: [{ name: 'message', label: 'Message', placeholder: 'Server maintenance in 10 minutes', required: true }] },
    { id: 'time-set', label: 'Set world time', permission: 'server.rcon', template: 'time set {time}', fields: [{ name: 'time', label: 'Time', placeholder: 'day', options: ['day', 'noon', 'night', 'midnight'], required: true }] },
    { id: 'weather', label: 'Set weather', permission: 'server.rcon', template: 'weather {weather}', fields: [{ name: 'weather', label: 'Weather', options: ['clear', 'rain', 'thunder'], required: true }] },
    { id: 'difficulty', label: 'Set difficulty', permission: 'server.rcon', template: 'difficulty {difficulty}', fields: [{ name: 'difficulty', label: 'Difficulty', options: ['peaceful', 'easy', 'normal', 'hard'], required: true }] }
];
const sessions = new Map();
let minecraftProcess = null;
let logBuffer = '';
let lifecycleOperation = null;
let rconOperation = null;
const metricsHistory = [];
let metricsSampleInProgress = false;
let metricsTimer = null;

function log(level, event, details = {}) {
    console.log(JSON.stringify({ time: new Date().toISOString(), level, event, details }));
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(morgan((tokens, req, res) => JSON.stringify({
    time: new Date().toISOString(), level: 'info', event: 'http.request',
    method: tokens.method(req, res), path: tokens.url(req, res), status: Number(tokens.status(req, res)),
    durationMs: Number(tokens['response-time'](req, res))
}), { skip: req => req.url === '/api/status' && req.headers['x-panel-poll'] === 'true' }));

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) { return `${salt}:${crypto.scryptSync(password, salt, 32).toString('hex')}`; }
function verifyPassword(password, stored) { const [salt, expected] = String(stored).split(':'); return !!salt && !!expected && crypto.timingSafeEqual(Buffer.from(crypto.scryptSync(password, salt, 32).toString('hex')), Buffer.from(expected)); }
function users() { return readJson(DATA_FILE, { users: [] }); }
function permissions(user) { return new Set(user?.admin ? FEATURE_KEYS : (user?.permissions || [])); }
function can(user, feature) { return permissions(user).has(feature); }
function ensureUserStore() {
    const data = users();
    if (!data.users.length) {
        if (!process.env.PANEL_ADMIN_PASSWORD) return log('warn', 'users.empty');
        data.users.push({ id: crypto.randomUUID(), username: 'admin', password: hashPassword(process.env.PANEL_ADMIN_PASSWORD), admin: true, permissions: FEATURE_KEYS });
        writeJson(DATA_FILE, data); log('info', 'users.initialized');
    } else if (process.env.PANEL_ADMIN_PASSWORD) log('warn', 'users.bootstrap.password.ignored');
}
function requireAuth(req, res, next) {
    const token = req.cookies.panel_session;
    const session = token && sessions.get(token);
    if (!session || session.expires < Date.now()) return res.status(401).json({ error: 'Authentication required.' });
    req.user = users().users.find(item => item.id === session.userId);
    return req.user ? next() : res.status(401).json({ error: 'Authentication required.' });
}
function requirePermission(feature) { return (req, res, next) => can(req.user, feature) ? next() : res.status(403).json({ error: 'Permission denied.' }); }
function run(command, args = [], options = {}) {
    return new Promise((resolve, reject) => execFile(command, args, { cwd: MINECRAFT_DIR, timeout: options.timeout ?? 3000 }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout.trim())));
}
function processInfo() {
    if (minecraftProcess && minecraftProcess.exitCode === null) return { running: true, pid: minecraftProcess.pid, owned: true };
    try { const pid = execFileSync('pgrep', ['-f', '[p]aper-.*\\.jar'], { encoding: 'utf8' }).trim().split('\n')[0]; if (pid) return { running: true, pid: Number(pid), owned: false }; } catch { }
    return { running: false };
}
function startServer() {
    if (processInfo().running) return false;
    const jar = fs.readdirSync(MINECRAFT_DIR).find(file => /^paper-.*\.jar$/.test(file));
    if (!jar) throw new Error('No Paper jar found in server/.');
    if (JAVA_HOME && !fs.existsSync(JAVA_COMMAND)) throw new Error(`JAVA_HOME does not contain a Java executable: ${JAVA_HOME}`);
    minecraftProcess = spawn(JAVA_COMMAND, ['-Xms1G', '-Xmx2G', '-jar', jar, '--nogui'], { cwd: MINECRAFT_DIR, stdio: ['pipe', 'pipe', 'pipe'] });
    minecraftProcess.stdout.on('data', chunk => { logBuffer = (logBuffer + chunk).slice(-120000); });
    minecraftProcess.stderr.on('data', chunk => { logBuffer = (logBuffer + chunk).slice(-120000); });
    minecraftProcess.on('exit', () => { minecraftProcess = null; });
    log('info', 'server.process.started', { pid: minecraftProcess.pid });
    return true;
}
function stopServer() {
    if (MINECRAFT_HOST) return dockerContainerAction('stop').then(() => true);
    if (!processInfo().running) return false;
    if (minecraftProcess?.exitCode === null) minecraftProcess.stdin.write('stop\n'); else rcon('stop').catch(() => { });
    return true;
}
function dockerRequest(method, requestPath) {
    return new Promise((resolve, reject) => {
        const request = require('http').request({ socketPath: DOCKER_SOCKET, path: `/v1.44${requestPath}`, method }, response => {
            let data = ''; response.setEncoding('utf8'); response.on('data', chunk => { data += chunk; });
            response.on('end', () => { let parsed; try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = data; } response.statusCode >= 400 ? reject(new Error(parsed.message || `Docker API returned ${response.statusCode}`)) : resolve(parsed); });
        });
        request.on('error', reject); request.end();
    });
}
function dockerContainerAction(action) { return dockerRequest('POST', `/containers/${encodeURIComponent(MINECRAFT_CONTAINER)}/${action}`); }
async function dockerStatus() { try { const info = await dockerRequest('GET', `/containers/${encodeURIComponent(MINECRAFT_CONTAINER)}/json`); return { running: !!info.State?.Running, pid: info.State?.Pid || 0, owned: false }; } catch { return { running: false }; } }
function rcon(command) {
    if (rconOperation) return Promise.reject(new Error('Another RCON command is already in progress.'));
    const properties = fs.existsSync(path.join(MINECRAFT_DIR, 'server.properties')) ? fs.readFileSync(path.join(MINECRAFT_DIR, 'server.properties'), 'utf8') : '';
    const get = key => properties.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] || '';
    if (!MINECRAFT_HOST && get('enable-rcon') !== 'true') return Promise.reject(new Error('RCON is disabled in server.properties.'));
    const password = process.env.MINECRAFT_RCON_PASSWORD || get('rcon.password').replace(/\\!/g, '!');
    const port = Number(process.env.MINECRAFT_RCON_PORT || get('rcon.port') || 25575);
    log('info', 'rcon.started', { host: MINECRAFT_HOST || '127.0.0.1', port });
    rconOperation = new Promise((resolve, reject) => {
        const client = new Rcon(MINECRAFT_HOST || '127.0.0.1', port, password, { tcp: true });
        let settled = false;
        const timer = setTimeout(() => finish(new Error('RCON timed out.')), 5000);
        const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); try { client.disconnect(); } catch { } error ? reject(error) : resolve(value); };
        client.on('auth', () => { log('info', 'rcon.authenticated'); client.send(command); });
        client.on('response', response => finish(null, response));
        client.on('error', error => finish(error));
        client.on('end', () => finish(new Error('RCON connection closed before a response.')));
        client.connect();
    });
    return rconOperation.finally(() => { log('info', 'rcon.finished'); rconOperation = null; });
}
async function metrics() {
    if (MINECRAFT_HOST) {
        const info = await dockerRequest('GET', `/containers/${encodeURIComponent(MINECRAFT_CONTAINER)}/stats?stream=false`);
        const cpuDelta = info.cpu_stats?.cpu_usage?.total_usage - info.precpu_stats?.cpu_usage?.total_usage || 0;
        const systemDelta = info.cpu_stats?.system_cpu_usage - info.precpu_stats?.system_cpu_usage || 0;
        return { server: await dockerStatus(), minecraftMemory: Math.round((info.memory_stats?.usage || 0) / 1024 / 1024), minecraftMemoryLimit: Math.round((info.memory_stats?.limit || 0) / 1024 / 1024), minecraftCpu: systemDelta ? Number(((cpuDelta / systemDelta) * (info.cpu_stats?.online_cpus || 1) * 100).toFixed(1)) : 0, minecraftCpuCores: info.cpu_stats?.online_cpus || os.cpus().length };
    }
    let disk = 'unavailable'; try { disk = await run('du', ['-sh', MINECRAFT_DIR]); } catch { }
    return { hostMemory: Math.round((1 - os.freemem() / os.totalmem()) * 100), nodeMemory: Math.round(process.memoryUsage().rss / 1024 / 1024), load: Number(os.loadavg()[0].toFixed(2)), disk, server: processInfo() };
}
async function sampleMetrics() {
    if (metricsSampleInProgress) return;
    metricsSampleInProgress = true;
    try {
        const result = await metrics();
        const timestamp = Date.now();
        if (result.minecraftCpu === undefined && result.minecraftMemory === undefined) return;
        metricsHistory.push({ timestamp, cpuPercent: result.minecraftCpu ?? 0, cpuCores: result.minecraftCpuCores || 0, memoryUsedMb: result.minecraftMemory ?? 0, memoryLimitMb: result.minecraftMemoryLimit ?? 0 });
        const cutoff = timestamp - METRICS_WINDOW_MS;
        while (metricsHistory.length && metricsHistory[0].timestamp < cutoff) metricsHistory.shift();
    } catch (error) {
        log('warn', 'metrics.sample.failed', { error: error.message });
    } finally {
        metricsSampleInProgress = false;
    }
}
function startMetricsSampler() {
    sampleMetrics();
    metricsTimer = setInterval(sampleMetrics, METRICS_INTERVAL_MS);
}
function metricsResponse(since) {
    const latestTimestamp = metricsHistory.at(-1)?.timestamp || null;
    const oldestTimestamp = metricsHistory[0]?.timestamp || null;
    const reset = since !== undefined && oldestTimestamp !== null && since < oldestTimestamp;
    const points = reset || since === undefined ? metricsHistory : metricsHistory.filter(point => point.timestamp > since);
    return { intervalMs: METRICS_INTERVAL_MS, windowMs: METRICS_WINDOW_MS, oldestTimestamp, latestTimestamp, reset, points };
}
const BACKUP_SCRIPT = path.join(MINECRAFT_DIR, '..', 'scripts', 'backup.sh');
function backup() { return run('/usr/bin/bash', [BACKUP_SCRIPT, 'create'], { timeout: 0 }); }
function backupList() {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR).filter(name => /^world_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.tar\.gz$/.test(name)).map(name => { const stat = fs.statSync(path.join(BACKUP_DIR, name)); return { name, createdAt: stat.mtime.toISOString(), size: stat.size }; }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function nextBackupAt() { const next = new Date(); next.setHours(4, 0, 0, 0); if (next <= new Date()) next.setDate(next.getDate() + 1); return next; }
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitForStopped() { for (let attempt = 0; attempt < 30; attempt += 1) { if (!(await dockerStatus()).running) return; await wait(1000); } throw new Error('Minecraft did not stop in time.'); }
async function runLifecycle(type, task) {
    if (lifecycleOperation) throw new Error(`A ${lifecycleOperation.type} operation is already in progress.`);
    lifecycleOperation = { type, phase: 'starting', startedAt: new Date().toISOString() }; log('info', `${type}.started`);
    try { return await task(lifecycleOperation); } catch (error) { log('error', `${type}.failed`, { error: error.message }); throw error; }
    finally { log('info', `${type}.finished`); lifecycleOperation = null; }
}
async function lifecycleAction(type, action) {
    return runLifecycle(type, async operation => {
        operation.phase = `${type} server`;
        if (MINECRAFT_HOST) return dockerContainerAction(action);
        if (type === 'start') return startServer(); if (type === 'stop') return stopServer(); await stopServer(); await wait(4000); return startServer();
    });
}
async function backupWithLifecycle() {
    return runLifecycle('backup', async operation => {
        operation.phase = 'checking server'; const wasRunning = MINECRAFT_HOST ? (await dockerStatus()).running : processInfo().running;
        if (wasRunning) {
            operation.phase = 'sending warning'; if (MINECRAFT_HOST) await rcon(`say Server backup begins in ${BACKUP_WARNING_SECONDS} seconds. Please finish what you are doing.`); else if (minecraftProcess?.stdin.writable) minecraftProcess.stdin.write(`say Server backup begins in ${BACKUP_WARNING_SECONDS} seconds. Please finish what you are doing.\n`);
            operation.phase = 'waiting for warning'; await wait(BACKUP_WARNING_SECONDS * 1000);
            operation.phase = 'stopping server'; if (MINECRAFT_HOST) { await dockerContainerAction('stop'); await waitForStopped(); } else await stopServer();
        }
        try { operation.phase = 'creating archive'; return await backup(); }
        finally { if (wasRunning) { operation.phase = 'starting server'; if (MINECRAFT_HOST) await dockerContainerAction('start'); else startServer(); } }
    });
}
async function restoreBackup(name) {
    return runLifecycle('restore', async operation => {
        operation.phase = 'validating backup'; if (!/^world_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.tar\.gz$/.test(name || '')) throw new Error('Invalid backup name.');
        const wasRunning = MINECRAFT_HOST ? (await dockerStatus()).running : processInfo().running;
        if (wasRunning) { operation.phase = 'stopping server'; if (MINECRAFT_HOST) { await rcon('say Server is shutting down to restore a backup.'); await dockerContainerAction('stop'); await waitForStopped(); } else await stopServer(); }
        try { operation.phase = 'restoring world'; return await run('/usr/bin/bash', [BACKUP_SCRIPT, 'restore', name], { timeout: 0 }); }
        finally { if (wasRunning) { operation.phase = 'starting server'; if (MINECRAFT_HOST) await dockerContainerAction('start'); else startServer(); } }
    });
}
function scheduleBackup() { const next = nextBackupAt(); setTimeout(async () => { try { await backupWithLifecycle(); } catch (error) { log('error', 'backup.scheduled.failed', { error: error.message }); } scheduleBackup(); }, next.getTime() - Date.now()); }
function busy(res) { return res.status(409).json({ error: `A ${lifecycleOperation.type} operation is already in progress.` }); }

app.get('/api/session', (req, res) => {
    const token = req.cookies.panel_session; const session = token && sessions.get(token); const user = session && users().users.find(item => item.id === session.userId);
    res.json({ user: user && session.expires >= Date.now() ? { username: user.username, admin: !!user.admin, permissions: [...permissions(user)] } : null, features: FEATURE_KEYS });
});
app.post('/api/login', (req, res) => {
    const found = users().users.find(item => item.username === req.body.username);
    if (!found || !verifyPassword(req.body.password || '', found.password)) { log('warn', 'auth.failed', { username: String(req.body.username || '') }); return res.status(401).json({ error: 'Invalid username or password.' }); }
    const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, { userId: found.id, expires: Date.now() + SESSION_TTL });
    res.cookie('panel_session', token, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: SESSION_TTL }); log('info', 'auth.succeeded', { username: found.username }); res.json({ ok: true });
});
app.use('/api', requireAuth);
app.get('/api/status', async (req, res) => {
    const result = {};
    result.server = MINECRAFT_HOST ? await dockerStatus() : processInfo();
    if (can(req.user, 'server.console')) result.logs = MINECRAFT_HOST && fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8').slice(-120000) : logBuffer;
    if (can(req.user, 'server.backups')) Object.assign(result, { backups: backupList(), nextBackup: nextBackupAt().toISOString() });
    result.lifecycle = lifecycleOperation ? { ...lifecycleOperation } : null; res.json(result);
});
app.get('/api/metrics', requirePermission('server.metrics'), (req, res) => {
    const rawSince = req.query.since;
    if (rawSince !== undefined && (!/^\d+$/.test(String(rawSince)) || !Number.isSafeInteger(Number(rawSince)))) return res.status(400).json({ error: 'since must be a Unix timestamp in milliseconds.' });
    res.json(metricsResponse(rawSince === undefined ? undefined : Number(rawSince)));
});
app.get('/api/commands', (req, res) => res.json({ commands: COMMAND_CATALOG.filter(command => can(req.user, command.permission)) }));
app.post('/api/logout', (req, res) => { if (req.cookies.panel_session) sessions.delete(req.cookies.panel_session); res.clearCookie('panel_session', { path: '/' }); res.status(204).end(); });
for (const action of ['start', 'stop', 'restart']) app.post(`/api/server/${action}`, requirePermission('server.control'), async (req, res) => { if (lifecycleOperation) return busy(res); await lifecycleAction(action, action); res.json({ ok: true }); });
app.post('/api/command', async (req, res) => {
    if (!can(req.user, 'server.console') && !can(req.user, 'server.rcon')) return res.status(403).json({ error: 'Permission denied.' });
    const definition = COMMAND_CATALOG.find(command => command.id === req.body.id && can(req.user, command.permission)); if (!definition) return res.status(400).json({ error: 'Command is not available for this account.' });
    if (MINECRAFT_HOST && rconOperation) return res.status(409).json({ error: 'Another RCON command is already in progress.' });
    const values = req.body.values || {}; if (definition.fields.some(field => field.required && !String(values[field.name] || '').trim())) return res.status(400).json({ error: 'All required command fields must be filled.' });
    const command = definition.command || definition.template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] || '').trim().replace(/[\r\n]/g, ' '));
    const output = MINECRAFT_HOST ? await rcon(command) : (processInfo().running ? (minecraftProcess.stdin.write(`${command}\n`), '') : ''); res.json({ ok: true, command, output });
});
app.post('/api/rcon', requirePermission('server.rcon'), async (req, res) => { if (rconOperation) return res.status(409).json({ error: 'Another RCON command is already in progress.' }); res.json({ output: await rcon(req.body.command || '') }); });
app.post('/api/backup', requirePermission('server.backups'), async (req, res) => { if (lifecycleOperation) return busy(res); res.json({ output: await backupWithLifecycle(), backups: backupList() }); });
app.post('/api/backups/restore', requirePermission('server.backups'), async (req, res) => { if (lifecycleOperation) return busy(res); res.json({ output: await restoreBackup(req.body.name), backups: backupList() }); });
app.get('/api/users', requirePermission('users.manage'), (req, res) => res.json({ users: users().users.map(({ id, username, admin, permissions: perms }) => ({ id, username, admin: !!admin, permissions: perms || [] })) }));
app.post('/api/users', requirePermission('users.manage'), (req, res) => {
    if (!req.body.username || !req.body.password) return res.status(400).json({ error: 'Username and password required.' });
    const data = users(); if (data.users.some(item => item.username === req.body.username)) return res.status(409).json({ error: 'Username already exists.' });
    data.users.push({ id: crypto.randomUUID(), username: req.body.username, password: hashPassword(req.body.password), admin: !!req.body.admin, permissions: req.body.permissions || [] }); writeJson(DATA_FILE, data); res.status(201).json({ ok: true });
});
app.patch('/api/users/:id', requirePermission('users.manage'), (req, res) => {
    const data = users(); const target = data.users.find(item => item.id === req.params.id); if (!target) return res.status(404).json({ error: 'User not found.' });
    if (target.id === req.user.id && req.body.admin === false) return res.status(400).json({ error: 'You cannot remove your own admin access.' });
    Object.assign(target, { admin: !!req.body.admin, permissions: req.body.permissions || [] }); if (req.body.password) target.password = hashPassword(req.body.password); writeJson(DATA_FILE, data); res.json({ ok: true });
});
app.delete('/api/users/:id', requirePermission('users.manage'), (req, res) => { if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' }); const data = users(); data.users = data.users.filter(item => item.id !== req.params.id); writeJson(DATA_FILE, data); res.status(204).end(); });
app.use(express.static(PUBLIC_DIR, { index: false }));
app.use((req, res) => req.url.startsWith('/api/') ? res.status(404).json({ error: 'Not found.' }) : res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.use((error, req, res, next) => { log('error', 'api.failed', { path: req.url, error: error.message }); if (!res.headersSent) res.status(500).json({ error: error.message }); });

ensureUserStore(); startMetricsSampler(); scheduleBackup();
app.listen(PORT, HOST, () => log('info', 'panel.listening', { host: HOST, port: PORT }));
