// Network routes: list / inspect / remove / prune / create.
// Mutating ops run as background tasks and return { ok, taskId }.
const express = require('express');
const d = require('../docker');
const tasks = require('../tasks');
const { asyncHandler, audit } = require('./util');
const { withDockerd } = require('../conn');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(await withDockerd(() => d.listNetworks()));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  res.json(await withDockerd(() => d.inspectNetwork(req.params.id)));
}));

router.delete('/:id', (req, res) => {
  const id = req.params.id; const user = req.session && req.session.username;
  const task = tasks.runTask({ type: 'network.remove', title: '删除网络 ' + id.slice(0, 12), detail: { id } }, async (tk) => {
    tk.log('删除网络 ' + id.slice(0, 12) + ' …'); await d.removeNetwork(id); audit(user, 'network.remove', id); tk.log('已删除');
  });
  res.json({ ok: true, taskId: task.id });
});

router.post('/prune', (req, res) => {
  const user = req.session && req.session.username;
  const task = tasks.runTask({ type: 'network.prune', title: '清理未使用网络', detail: {} }, async (tk) => {
    tk.log('清理中…'); const r = await d.pruneNetworks(); audit(user, 'network.prune', ''); tk.log('已清理'); return r;
  });
  res.json({ ok: true, taskId: task.id });
});

router.post('/', (req, res) => {
  const user = req.session && req.session.username;
  const spec = req.body || {};
  const task = tasks.runTask({ type: 'network.create', title: '新建网络 ' + (spec.name || ''), detail: { name: spec.name } }, async (tk) => {
    tk.log('创建网络 ' + spec.name + ' …'); const r = await d.createNetwork(spec); audit(user, 'network.create', (r && r.name) || spec.name); tk.log('已创建'); return r;
  });
  res.json({ ok: true, taskId: task.id });
});

// 将容器热插拔接入/断开本网络（docker network connect / disconnect）。
router.post('/:id/connect', (req, res) => {
  const id = req.params.id; const user = req.session && req.session.username;
  const { container, ipv4 } = req.body || {};
  if (!container) return res.status(400).json({ error: 'container 必填' });
  const task = tasks.runTask({ type: 'network.connect', title: '接入容器到网络 ' + id.slice(0, 12), detail: { id, container } }, async (tk) => {
    tk.log('接入中…'); await d.connectNetwork(id, container, ipv4 ? { Ipv4Address: ipv4 } : null);
    audit(user, 'network.connect', `${container} -> ${id}`); tk.log('已接入');
  });
  res.json({ ok: true, taskId: task.id });
});

router.post('/:id/disconnect', (req, res) => {
  const id = req.params.id; const user = req.session && req.session.username;
  const { container } = req.body || {};
  if (!container) return res.status(400).json({ error: 'container 必填' });
  const task = tasks.runTask({ type: 'network.disconnect', title: '从网络断开容器 ' + id.slice(0, 12), detail: { id, container } }, async (tk) => {
    tk.log('断开中…'); await d.disconnectNetwork(id, container, true);
    audit(user, 'network.disconnect', `${container} -> ${id}`); tk.log('已断开');
  });
  res.json({ ok: true, taskId: task.id });
});

module.exports = router;
