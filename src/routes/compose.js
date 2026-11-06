// WslDockerManager - Stage 3: Compose stack management.
// Each "stack" = a subdir under cfg.composeDirAbs containing a docker-compose file.
// docker compose is executed *inside* the WSL distro via wsl.dockerCompose (which
// translates the Windows cwd into /mnt/d/... so bind mounts to Windows folders work).
const express = require('express');
const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const { dockerCompose } = require('../wsl');

const router = express.Router();

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
// stack names must be filesystem-safe (also used as the compose project name)
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

function composeDirFor(name) {
  return path.join(cfg.composeDirAbs, name);
}
function findComposeFile(dir) {
  for (const n of COMPOSE_FILES) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
function listStackNames() {
  const base = cfg.composeDirAbs;
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => findComposeFile(composeDirFor(name)));
}
function readComposeContent(name) {
  const cf = findComposeFile(composeDirFor(name));
  if (!cf) throw new Error('compose file not found for stack: ' + name);
  return fs.readFileSync(cf, 'utf8');
}

// docker compose ps --format json emits one JSON object per line (or a single array)
function parseComposePs(out) {
  if (!out || !out.trim()) return [];
  const arr = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { arr.push(JSON.parse(t)); } catch (e) { /* skip non-json */ }
  }
  if (arr.length === 0) {
    try {
      const v = JSON.parse(out.trim());
      if (Array.isArray(v)) return v;
    } catch (e) { /* ignore */ }
  }
  return arr;
}
function summarizeContainers(containers) {
  return containers.map((c) => ({
    name: c.Name || c.name,
    service: c.Service || c.service,
    state: c.State || c.state,
    status: c.Status || c.status,
    image: c.Image || c.image,
  }));
}

// GET /api/compose -> list stacks (with live status)
router.get('/', async (req, res) => {
  try {
    const names = listStackNames();
    const stacks = [];
    for (const name of names) {
      const dir = composeDirFor(name);
      const cf = findComposeFile(dir);
      let containers = [];
      try {
        const out = await dockerCompose(['ps', '--format', 'json'], { cwd: dir, timeout: 30000 });
        containers = parseComposePs(out);
      } catch (e) { /* stack may be down */ }
      const summarized = summarizeContainers(containers);
      const running = summarized.filter((c) => /up|running/i.test(c.state || c.status || '')).length;
      stacks.push({
        name,
        composeFile: path.basename(cf),
        containerCount: summarized.length,
        runningCount: running,
        status: summarized.length === 0 ? 'stopped' : (running === summarized.length ? 'running' : 'partial'),
        containers: summarized,
      });
    }
    res.json({ stacks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/compose/:name -> detail (compose source + services + containers)
router.get('/:name', async (req, res) => {
  try {
    const { name } = req.params;
    if (!SAFE_NAME.test(name)) return res.status(400).json({ error: 'invalid stack name' });
    if (!findComposeFile(composeDirFor(name))) return res.status(404).json({ error: 'stack not found' });
    const dir = composeDirFor(name);
    const content = readComposeContent(name);
    let services = [];
    try {
      const s = await dockerCompose(['config', '--services'], { cwd: dir, timeout: 30000 });
      services = s.split('\n').map((x) => x.trim()).filter(Boolean);
    } catch (e) { /* ignore */ }
    let containers = [];
    try {
      const out = await dockerCompose(['ps', '--format', 'json'], { cwd: dir, timeout: 30000 });
      containers = summarizeContainers(parseComposePs(out));
    } catch (e) { /* ignore */ }
    res.json({ name, composeFile: path.basename(findComposeFile(dir)), content, services, containers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/compose -> create a new stack (dir + docker-compose.yml)
router.post('/', async (req, res) => {
  try {
    const { name, content } = req.body || {};
    if (!name || !SAFE_NAME.test(name)) return res.status(400).json({ error: 'invalid or missing name' });
    if (content == null) return res.status(400).json({ error: 'missing content' });
    const dir = composeDirFor(name);
    if (fs.existsSync(dir)) return res.status(409).json({ error: 'stack already exists' });
    fs.mkdirSync(dir, { recursive: true });
    const cf = path.join(dir, 'docker-compose.yml');
    fs.writeFileSync(cf, content, 'utf8');
    res.json({ ok: true, name, composeFile: 'docker-compose.yml' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/compose/:name -> update compose source (old file backed up)
router.put('/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const { content } = req.body || {};
    if (!SAFE_NAME.test(name)) return res.status(400).json({ error: 'invalid stack name' });
    const cf = findComposeFile(composeDirFor(name));
    if (!cf) return res.status(404).json({ error: 'stack not found' });
    if (content == null) return res.status(400).json({ error: 'missing content' });
    const bak = cf + '.bak.' + Date.now();
    fs.copyFileSync(cf, bak);
    fs.writeFileSync(cf, content, 'utf8');
    res.json({ ok: true, backup: path.basename(bak) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/compose/:name/up -> docker compose up -d
router.post('/:name/up', async (req, res) => {
  try {
    const { name } = req.params;
    if (!SAFE_NAME.test(name)) return res.status(400).json({ error: 'invalid stack name' });
    if (!findComposeFile(composeDirFor(name))) return res.status(404).json({ error: 'stack not found' });
    const out = await dockerCompose(['up', '-d'], { cwd: composeDirFor(name), timeout: 300000 });
    res.json({ ok: true, output: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/compose/:name/down -> docker compose down
router.post('/:name/down', async (req, res) => {
  try {
    const { name } = req.params;
    if (!SAFE_NAME.test(name)) return res.status(400).json({ error: 'invalid stack name' });
    if (!findComposeFile(composeDirFor(name))) return res.status(404).json({ error: 'stack not found' });
    const out = await dockerCompose(['down'], { cwd: composeDirFor(name), timeout: 120000 });
    res.json({ ok: true, output: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/compose/:name/restart -> docker compose restart
router.post('/:name/restart', async (req, res) => {
  try {
    const { name } = req.params;
    if (!SAFE_NAME.test(name)) return res.status(400).json({ error: 'invalid stack name' });
    if (!findComposeFile(composeDirFor(name))) return res.status(404).json({ error: 'stack not found' });
    const out = await dockerCompose(['restart'], { cwd: composeDirFor(name), timeout: 120000 });
    res.json({ ok: true, output: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/compose/:name/pull -> docker compose pull
router.post('/:name/pull', async (req, res) => {
  try {
    const { name } = req.params;
    if (!SAFE_NAME.test(name)) return res.status(400).json({ error: 'invalid stack name' });
    if (!findComposeFile(composeDirFor(name))) return res.status(404).json({ error: 'stack not found' });
    const out = await dockerCompose(['pull'], { cwd: composeDirFor(name), timeout: 300000 });
    res.json({ ok: true, output: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/compose/:name/logs -> docker compose logs (plain text)
router.get('/:name/logs', async (req, res) => {
  try {
    const { name } = req.params;
    if (!SAFE_NAME.test(name)) return res.status(400).json({ error: 'invalid stack name' });
    if (!findComposeFile(composeDirFor(name))) return res.status(404).json({ error: 'stack not found' });
    const args = ['logs', '--no-color'];
    if (req.query.tail) args.push('--tail', String(req.query.tail));
    else args.push('--tail', '200');
    if (req.query.service) args.push(String(req.query.service));
    const out = await dockerCompose(args, { cwd: composeDirFor(name), timeout: 30000 });
    res.type('text/plain').send(out || '');
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// DELETE /api/compose/:name -> down then remove the stack directory
router.delete('/:name', async (req, res) => {
  try {
    const { name } = req.params;
    if (!SAFE_NAME.test(name)) return res.status(400).json({ error: 'invalid stack name' });
    const dir = composeDirFor(name);
    if (!findComposeFile(dir)) return res.status(404).json({ error: 'stack not found' });
    try {
      await dockerCompose(['down'], { cwd: dir, timeout: 120000 });
    } catch (e) { /* already down */ }
    fs.rmSync(dir, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
