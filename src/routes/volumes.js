// Volume routes: list / inspect / remove / prune / create.
// Mutating ops run as background tasks and return { ok, taskId }.
const express = require('express');
const d = require('../docker');
const tasks = require('../tasks');
const { asyncHandler, audit } = require('./util');
const { withDockerd } = require('../conn');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(await withDockerd(() => d.listVolumes()));
}));

router.get('/:name', asyncHandler(async (req, res) => {
  res.json(await withDockerd(() => d.inspectVolume(req.params.name)));
}));

router.delete('/:name', (req, res) => {
  const name = req.params.name; const user = req.session && req.session.username;
  const task = tasks.runTask({ type: 'volume.remove', title: '删除卷 ' + name, detail: { name } }, async (tk) => {
    tk.log('删除卷 ' + name + ' …'); await d.removeVolume(name); audit(user, 'volume.remove', name); tk.log('已删除');
  });
  res.json({ ok: true, taskId: task.id });
});

router.post('/prune', (req, res) => {
  const user = req.session && req.session.username;
  const task = tasks.runTask({ type: 'volume.prune', title: '清理未使用卷', detail: {} }, async (tk) => {
    tk.log('清理中…'); const r = await d.pruneVolumes(); audit(user, 'volume.prune', ''); tk.log('已清理'); return r;
  });
  res.json({ ok: true, taskId: task.id });
});

router.post('/', (req, res) => {
  const user = req.session && req.session.username;
  const spec = req.body || {};
  const task = tasks.runTask({ type: 'volume.create', title: '新建卷 ' + (spec.name || ''), detail: { name: spec.name } }, async (tk) => {
    tk.log('创建卷 ' + spec.name + ' …'); const v = await d.createVolume(spec); audit(user, 'volume.create', v.Name); tk.log('已创建'); return v;
  });
  res.json({ ok: true, taskId: task.id });
});

// 卷备份：把卷内容打包成 tar.gz 并触发浏览器下载。
router.get('/:name/backup', asyncHandler(async (req, res) => {
  const name = req.params.name;
  const file = await d.backupVolume(name);
  res.download(file, name + '.tar.gz', () => {
    try { fs.unlinkSync(file); fs.rmdirSync(path.dirname(file), { recursive: true }); } catch (_) {}
  });
}));

// 卷恢复：上传 tar.gz 解包回卷（先清空旧内容）。
router.post('/:name/restore', (req, res) => {
  const name = req.params.name; const user = req.session && req.session.username;
  const tmp = path.join(require('os').tmpdir(), 'wslmgr-restore-' + Date.now() + '.tar.gz');
  const ws = fs.createWriteStream(tmp);
  req.pipe(ws);
  ws.on('error', (e) => { if (!res.headersSent) res.status(500).json({ error: '写入临时文件失败: ' + e.message }); });
  ws.on('finish', () => {
    const task = tasks.createTask({ type: 'volume.restore', title: '恢复卷 ' + name, detail: { name } });
    (async () => {
      try {
        await d.restoreVolume(name, tmp);
        audit(user, 'volume.restore', name);
        tasks.finishTask(task.id, { status: 'success' });
      } catch (e) {
        tasks.finishTask(task.id, { status: 'error', error: e.message });
      } finally {
        fs.unlink(tmp, () => {});
      }
    })();
    res.json({ ok: true, taskId: task.id });
  });
});

module.exports = router;
