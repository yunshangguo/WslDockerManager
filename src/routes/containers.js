// Container lifecycle + logs + stats routes.
// Reads are direct; mutating ops (create/start/stop/restart/kill/pause/unpause/
// remove) run as background tasks and return { ok, taskId } immediately.
const express = require('express');
const d = require('../docker');
const tasks = require('../tasks');
const { asyncHandler, audit } = require('./util');
const { withDockerd } = require('../conn');

const router = express.Router();

function label(id) { return (id || '').slice(0, 12); }

// Operation-level dockerd recovery is now shared via src/conn.js withDockerd:
// gentle retries first (ride out a momentary WSL localhost forward blip), then
// force dockerd up via ensureDockerd(true) and retry once. This is what makes
// "读取容器配置失败：connect ECONNREFUSED 127.0.0.1:2375" disappear for the
// momentary gaps instead of erroring the user's action.

router.get('/', asyncHandler(async (req, res) => {
  const all = req.query.all === 'false' ? false : true;
  res.json(await withDockerd(() => d.listContainers(all)));
}));

// Batch one-shot stats for the list page (CPU / memory columns).
// Declared before '/:id' so "stats" is not swallowed as a container id.
router.get('/stats', asyncHandler(async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!ids.length) { res.json({ stats: {} }); return; }
  res.json({ stats: await withDockerd(() => d.containerStatsBatch(ids)) });
}));


router.post('/batch', (req, res) => {
  const user = req.session && req.session.username;
  const { ids, action } = req.body || {};
  const list = Array.isArray(ids) ? ids : [];
  const act = action;
  if (!list.length) return res.status(400).json({ error: 'ids 必填' });
  if (!['start', 'stop', 'remove', 'restart', 'update'].includes(act)) return res.status(400).json({ error: 'action 必须是 start/stop/remove/restart/update' });
  const labelAct = act === 'start' ? '启动' : act === 'stop' ? '停止' : act === 'remove' ? '删除' : act === 'restart' ? '重启' : '更新镜像';
  const task = tasks.runTask({ type: 'container.batch', title: `批量${labelAct} ${list.length} 个容器`, detail: { ids, action: act } }, async (tk) => {
    let ok = 0, failN = 0;
    for (const id of list) {
      try {
        if (act === 'start') await d.startContainer(id);
        else if (act === 'stop') await d.stopContainer(id);
        else if (act === 'restart') await d.restartContainer(id);
        else if (act === 'update') await d.updateContainerImage(id);
        else await d.removeContainer(id, { force: true, v: true });
        ok++; tk.log(label(id) + ' ' + labelAct + ' 成功 (' + ok + '/' + list.length + ')');
      } catch (e) { failN++; tk.log(label(id) + ' 失败: ' + e.message); }
    }
    audit(user, 'container.batch', `${act} ids=${list.length} ok=${ok} fail=${failN}`);
    tk.log(`完成：成功 ${ok}，失败 ${failN}`);
    return { ok, fail: failN };
  });
  res.json({ ok: true, taskId: task.id });
});

router.post('/prune', (req, res) => {
  const user = req.session && req.session.username;
  const task = tasks.runTask({ type: 'container.prune', title: '清理已停止容器', detail: {} }, async (tk) => {
    tk.log('正在清理所有已停止的容器…');
    const r = await d.pruneContainers();
    audit(user, 'container.prune', 'reclaimed=' + r.reclaimed);
    tk.log('已清理 ' + r.reclaimed + ' 个容器');
    return r;
  });
  res.json({ ok: true, taskId: task.id });
});

router.get('/:id', asyncHandler(async (req, res) => {
  res.json(await withDockerd(() => d.inspectContainer(req.params.id)));
}));

router.get('/:id/logs', asyncHandler(async (req, res) => {
  const opts = {
    tail: req.query.tail ? parseInt(req.query.tail, 10) : 100,
    since: req.query.since,
    until: req.query.until,
    timestamps: req.query.timestamps === '1',
  };
  // 套超时：docker 守护进程无响应时 fail-fast，避免请求挂起被网关判成 502。
  const frames = await withDockerd(() => d.withTimeout(d.containerLogs(req.params.id, opts), 20000, '容器日志拉取'));
  res.json({ id: req.params.id, frames });
}));
router.get('/:id/logs/stream', (req, res) => {
  const id = req.params.id;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  let closed = false;
  req.on('close', () => { closed = true; });
  (async () => {
    try {
      const stream = await d.docker.getContainer(id).logs({ follow: true, stdout: true, stderr: true, timestamps: true, decode: true });
      stream.on('data', (chunk) => {
        if (closed) return;
        const text = String(chunk);
        const payload = text.split('\n').map((l) => 'data: ' + l).join('\n') + '\n\n';
        res.write(payload);
      });
      stream.on('end', () => { if (!closed) res.end(); });
    } catch (e) {
      if (!closed) { res.write('event: error\ndata: ' + e.message + '\n\n'); res.end(); }
    }
  })();
});


router.get('/:id/stats', asyncHandler(async (req, res) => {
  res.json(await withDockerd(() => d.containerStats(req.params.id)));
}));

router.post('/', (req, res) => {
  const user = req.session && req.session.username;
  const spec = req.body || {};
  const start = req.query.start !== 'false';
  const task = tasks.runTask(
    { type: 'container.create', title: '创建容器 ' + (spec.name || spec.image || ''), detail: { image: spec.image } },
    async (tk) => {
      tk.log('正在创建容器，镜像 ' + spec.image);
      const r = await d.createContainer(spec, start);
      audit(user, 'container.create', `${r.id} image=${spec.image}`);
      tk.log('已创建 ' + r.shortId + (start ? '（已启动）' : '（未启动）'));
      return r;
    }
  );
  res.json({ ok: true, taskId: task.id });
});

router.post('/:id/start', (req, res) => {
  const id = req.params.id; const user = req.session && req.session.username;
  const task = tasks.runTask({ type: 'container.start', title: '启动容器 ' + label(id), detail: { id } }, async (tk) => {
    tk.log('启动中…'); await d.startContainer(id); audit(user, 'container.start', id); tk.log('已启动');
  });
  res.json({ ok: true, taskId: task.id });
});

router.post('/:id/stop', (req, res) => {
  const id = req.params.id; const user = req.session && req.session.username;
  const t = req.query.t ? parseInt(req.query.t, 10) : undefined;
  const task = tasks.runTask({ type: 'container.stop', title: '停止容器 ' + label(id), detail: { id } }, async (tk) => {
    tk.log('停止中…'); await d.stopContainer(id, { t }); audit(user, 'container.stop', id); tk.log('已停止');
  });
  res.json({ ok: true, taskId: task.id });
});

router.post('/:id/restart', (req, res) => {
  const id = req.params.id; const user = req.session && req.session.username;
  const t = req.query.t ? parseInt(req.query.t, 10) : undefined;
  const task = tasks.runTask({ type: 'container.restart', title: '重启容器 ' + label(id), detail: { id } }, async (tk) => {
    tk.log('重启中…'); await d.restartContainer(id, { t }); audit(user, 'container.restart', id); tk.log('已重启');
  });
  res.json({ ok: true, taskId: task.id });
});

router.post('/:id/kill', (req, res) => {
  const id = req.params.id; const user = req.session && req.session.username;
  const task = tasks.runTask({ type: 'container.kill', title: '强制杀掉容器 ' + label(id), detail: { id } }, async (tk) => {
    tk.log('Killing…'); await d.killContainer(id, { signal: req.query.signal }); audit(user, 'container.kill', id); tk.log('已杀掉');
  });
  res.json({ ok: true, taskId: task.id });
});

router.post('/:id/pause', (req, res) => {
  const id = req.params.id; const user = req.session && req.session.username;
  const task = tasks.runTask({ type: 'container.pause', title: '暂停容器 ' + label(id), detail: { id } }, async (tk) => {
    tk.log('暂停中…'); await d.pauseContainer(id); audit(user, 'container.pause', id); tk.log('已暂停');
  });
  res.json({ ok: true, taskId: task.id });
});

router.post('/:id/unpause', (req, res) => {
  const id = req.params.id; const user = req.session && req.session.username;
  const task = tasks.runTask({ type: 'container.unpause', title: '恢复容器 ' + label(id), detail: { id } }, async (tk) => {
    tk.log('恢复中…'); await d.unpauseContainer(id); audit(user, 'container.unpause', id); tk.log('已恢复');
  });
  res.json({ ok: true, taskId: task.id });
});

router.delete('/:id', (req, res) => {
  const id = req.params.id; const user = req.session && req.session.username;
  const force = req.query.force === '1'; const v = req.query.v === '1';
  const task = tasks.runTask({ type: 'container.remove', title: '删除容器 ' + label(id), detail: { id, force, v } }, async (tk) => {
    tk.log('删除中…'); await d.removeContainer(id, { force, v, link: false }); audit(user, 'container.remove', `${id} force=${force}`); tk.log('已删除');
  });
  res.json({ ok: true, taskId: task.id });
});

// Non-interactive command execution inside a container (lightweight shell).
router.post('/:id/exec', asyncHandler(async (req, res) => {
  const { cmd } = req.body || {};
  if (!cmd || !cmd.trim()) return res.status(400).json({ error: '命令不能为空' });
  const out = await d.execInContainer(req.params.id, cmd);
  res.json({ output: out });
}));

// Recreate the container with the same config without pulling a new image.

// P1.9 配置在线编辑：合并覆盖项后重建（沿用 recreate 基础）
router.post('/:id/configure', (req, res) => {
  const id = req.params.id; const user = req.session && req.session.username;
  const body = req.body || {};
  const task = tasks.runTask({ type: 'container.recreate', title: '更新配置并重建容器 ' + label(id), detail: { id } }, async (tk) => {
    tk.log('按新配置删除并重建容器…');
    const r = await d.recreateContainer(id, body);
    audit(user, 'container.configure', `${id} -> ${r.id}`);
    tk.log('已重建 ' + r.shortId);
    return r;
  });
  res.json({ ok: true, taskId: task.id });
});
router.post('/:id/recreate', (req, res) => {
  const id = req.params.id; const user = req.session && req.session.username;
  const task = tasks.runTask({ type: 'container.recreate', title: '重构（重建）容器 ' + label(id), detail: { id } }, async (tk) => {
    tk.log('按原配置删除并重建容器…');
    const r = await d.recreateContainer(id);
    audit(user, 'container.recreate', `${id} -> ${r.id}`);
    tk.log('已重建 ' + r.shortId);
    return r;
  });
  res.json({ ok: true, taskId: task.id });
});

// Pull the latest image and recreate the container with the same config.
router.post('/:id/update', (req, res) => {
  const id = req.params.id; const user = req.session && req.session.username;
  const task = tasks.runTask({ type: 'container.update', title: '更新镜像并重建容器 ' + label(id), detail: { id } }, async (tk) => {
    tk.log('拉取最新镜像并重建容器…');
    const r = await d.updateContainerImage(id);
    audit(user, 'container.update', `${id} -> ${r.id}`);
    tk.log('已重建 ' + r.shortId);
    return r;
  });
  res.json({ ok: true, taskId: task.id });
});


// Rename a container (docker rename).
router.post('/:id/rename', (req, res) => {
  const id = req.params.id; const user = req.session && req.session.username;
  const name = req.body && req.body.name;
  if (!name) return res.status(400).json({ error: '新名称必填' });
  const task = tasks.runTask({ type: 'container.rename', title: '重命名容器 ' + label(id), detail: { id, name } }, async (tk) => {
    tk.log('重命名中…');
    const r = await d.renameContainer(id, name);
    audit(user, 'container.rename', id + ' -> ' + r.name);
    tk.log('已重命名为 ' + r.name);
    return r;
  });
  res.json({ ok: true, taskId: task.id });
});

// 实时修改容器运行时限制（CPU/内存/重启策略），无需重建容器。
router.post('/:id/update-config', (req, res) => {
  const id = req.params.id; const user = req.session && req.session.username;
  const body = req.body || {};
  const task = tasks.runTask({ type: 'container.update-config', title: '更新运行时配置 ' + label(id), detail: { id, body } }, async (tk) => {
    tk.log('应用新的运行时限制…');
    const r = await withDockerd(() => d.updateContainer(id, body));
    audit(user, 'container.update-config', `${id} ${Object.keys(r.applied || {}).join(',')}`);
    tk.log('已更新：' + Object.keys(r.applied || {}).join(', '));
    return r;
  });
  res.json({ ok: true, taskId: task.id });
});

// 将容器提交为新的镜像（docker commit）。
router.post('/:id/commit', (req, res) => {
  const id = req.params.id; const user = req.session && req.session.username;
  const body = req.body || {};
  const task = tasks.runTask({ type: 'container.commit', title: '提交为镜像 ' + label(id), detail: { id, repo: body.repo } }, async (tk) => {
    tk.log('提交容器文件系统为镜像…');
    const r = await d.commitContainer(id, body);
    audit(user, 'container.commit', `${id} -> ${r.ref || r.id}`);
    tk.log('已生成镜像 ' + (r.ref || r.id));
    return r;
  });
  res.json({ ok: true, taskId: task.id });
});

module.exports = router;
