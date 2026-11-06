// Image routes: list / inspect / remove / prune / pull.
// Mutating operations run as background tasks so the UI can show live progress
// and a task log; each returns { ok, taskId } immediately.
const express = require('express');
const fs = require('fs');
const path = require('path');
const d = require('../docker');
const tasks = require('../tasks');
const { asyncHandler, audit } = require('./util');
const { withDockerd } = require('../conn');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(await withDockerd(() => d.listImages()));
}));

// 读取上次镜像更新检测结果（供容器 / 镜像页标记"可更新"徽标）。
router.get('/updates', (req, res) => {
  res.json(d.getImageUpdates());
});

// 触发一次镜像更新检测：逐个 tag 比对本地 digest 与远端 manifest digest，
// 结果写入 data/image-updates.json，进度流式输出到后台任务日志。
// 声明在 '/:id' 之前，避免被 ':id' 通配吞掉。
router.post('/updates/check', (req, res) => {
  const user = req.session && req.session.username;
  const task = tasks.createTask({ type: 'image.updates.check', title: '检查镜像更新', detail: {} });
  (async () => {
    try {
      const data = await d.checkImageUpdates((msg) => tasks.appendLog(task.id, msg));
      audit(user, 'image.updates.check', `total=${data.total || 0} checked=${data.checked || 0}`);
      const updatable = Object.keys(data.byRef || {}).filter((k) => data.byRef[k] && data.byRef[k].hasUpdate).length;
      tasks.finishTask(task.id, { status: 'success', summary: `已检查 ${Object.keys(data.byRef || {}).length} 个引用，发现 ${updatable} 个可更新` });
    } catch (e) {
      tasks.finishTask(task.id, { status: 'error', error: e.message });
    }
  })();
  res.json({ ok: true, taskId: task.id });
});

router.get('/:id', asyncHandler(async (req, res) => {
  res.json(await withDockerd(() => d.inspectImage(req.params.id)));
}));

router.get('/:id/history', asyncHandler(async (req, res) => {
  res.json({ id: req.params.id, history: await withDockerd(() => d.imageHistory(req.params.id)) });
}));

router.delete('/:id', (req, res) => {
  const id = req.params.id;
  const user = req.session && req.session.username;
  const force = req.query.force === '1';
  const task = tasks.runTask(
    { type: 'image.remove', title: '删除镜像 ' + id.slice(0, 18), detail: { id, force } },
    async (tk) => {
      tk.log('正在删除镜像 ' + id);
      await d.removeImage(id, { force });
      audit(user, 'image.remove', `${id} force=${force}`);
      tk.log('镜像已删除');
    }
  );
  res.json({ ok: true, taskId: task.id });
});

router.post('/prune', (req, res) => {
  const user = req.session && req.session.username;
  const task = tasks.runTask(
    { type: 'image.prune', title: '清理悬空镜像', detail: {} },
    async (tk) => {
      tk.log('正在清理悬空镜像…');
      const r = await d.pruneImages();
      audit(user, 'image.prune', `reclaimed=${r.SpaceReclaimed || 0}`);
      tk.log('已回收 ' + ((r.SpaceReclaimed || 0) / 1048576).toFixed(1) + ' MB');
      return r;
    }
  );
  res.json({ ok: true, taskId: task.id });
});

// Prepend a registry host to an image ref if the user chose a non-default source.
// Skips qualification if the image already carries a registry (has a host-like
// first segment) so we never double-prefix.
function qualifyImage(image, registry) {
  if (!registry) return image;
  registry = String(registry).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!registry) return image;
  const firstSeg = image.split('/')[0];
  const hasRegistry = firstSeg.includes('.') || firstSeg.includes(':') || firstSeg === 'localhost';
  if (hasRegistry) return image;
  return `${registry}/${image}`;
}

function fmtPullEvent(evt) {
  const id = evt.id ? evt.id.slice(0, 12) : '';
  const status = evt.status || '';
  const prefix = id ? '[' + id + '] ' : '';
  if (evt.progress) return prefix + status + ' ' + evt.progress;
  return prefix + status;
}

// 去掉镜像引用开头的 registry 主机部分（仅当首段含 "." / ":" 或正好是 localhost 时）。
// docker.1panel.live/linuxserver/jackett -> linuxserver/jackett；linuxserver/jackett 保持不变。
function stripRegistry(ref) {
  const i = ref.indexOf('/');
  if (i === -1) return ref;
  const first = ref.slice(0, i);
  if (first.includes('.') || first.includes(':') || first === 'localhost') return ref.slice(i + 1);
  return ref;
}

// 检查镜像是否真的落地到本地 docker 存储。
// repoTag 形如 "registry/name:tag" / "name:tag" / "name"（tag 缺省 latest）。
// 镜像代理（如 1Panel）可能把镜像在本地还原为不带 registry 前缀的 tag，
// 因此同时匹配「带前缀」与「去掉 registry 前缀」两种形式，避免误判未落地。
async function imageLanded(repoTag) {
  const norm = (s) => (s.includes(':') ? s : s + ':latest');
  const target = norm(repoTag);
  const noRegistry = norm(stripRegistry(repoTag));
  const imgs = await d.listImages();
  for (const img of imgs) {
    for (const t of (img.RepoTags || [])) {
      const nt = norm(t);
      if (nt === target || nt === noRegistry) return true;
    }
  }
  return false;
}

router.post('/pull', (req, res) => {
  let repoTag = (req.body && (req.body.image || req.body.repoTag));
  if (!repoTag) return res.status(400).json({ error: 'image (repo:tag) required' });
  if (req.body.registry) repoTag = qualifyImage(repoTag, req.body.registry);
  const user = req.session && req.session.username;
  const task = tasks.createTask({ type: 'image.pull', title: '拉取镜像 ' + repoTag, detail: { repoTag } });
  const layers = {};
  let lastErr = null;
  (async () => {
    try {
      await d.pullImage(repoTag, (evt) => {
        const isErr = evt.status && /error|denied|unauthorized|not found|no such|manifest/i.test(evt.status);
        if (isErr) lastErr = evt.status;
        tasks.appendLog(task.id, fmtPullEvent(evt), isErr ? 'err' : 'info');
        if (evt.id && evt.progressDetail && evt.progressDetail.total) {
          layers[evt.id] = { cur: evt.progressDetail.current || 0, tot: evt.progressDetail.total || 0 };
          let cur = 0, tot = 0;
          for (const k in layers) { cur += layers[k].cur; tot += layers[k].tot; }
          if (tot > 0) tasks.setProgress(task.id, Math.min(99, Math.round((cur / tot) * 100)));
        }
      });
      audit(user, 'image.pull', repoTag);
      // docker 可能在进度流里报告错误却仍让 followProgress resolve（假成功），这里兜底拦截
      if (lastErr) throw new Error('拉取过程中 docker 报告错误：' + lastErr);
      // 落地校验：确认镜像真的出现在本地，避免 docker 报告成功但存储缺失时误导用户
      const landed = await imageLanded(repoTag);
      if (!landed) {
        throw new Error('拉取流程已结束，但本地未找到镜像「' + repoTag + '」。1Panel 代理可能未真正下载完成（可用「镜像源设置→开始诊断」检查连通性，或改用自定义 registry 前缀）');
      }
      tasks.finishTask(task.id, { status: 'success' });
    } catch (e) {
      tasks.finishTask(task.id, { status: 'error', error: e.message });
    }
  })();
  res.json({ ok: true, taskId: task.id, image: repoTag });
});

// ---- per-image edit operations ----------------------------------------------

// 标记（修改版本）：为镜像创建新 tag 别名。
router.post('/tag', (req, res) => {
  const id = (req.body && (req.body.id || req.body.image));
  const target = req.body && req.body.target;
  if (!id || !target) return res.status(400).json({ error: 'id 与 target 必填' });
  const user = req.session && req.session.username;
  const task = tasks.createTask({ type: 'image.tag', title: '标记镜像 ' + target, detail: { id, target } });
  (async () => {
    try {
      await d.tagImage(id, target.trim());
      audit(user, 'image.tag', `${id} -> ${target}`);
      tasks.finishTask(task.id, { status: 'success' });
    } catch (e) {
      tasks.finishTask(task.id, { status: 'error', error: e.message });
    }
  })();
  res.json({ ok: true, taskId: task.id });
});

// 推送镜像到 registry。
// - 不传 target：直接推送镜像第一个「含 registry 主机」的 tag（如 docker.1panel.live/...、用户名/...）。
// - 传 target：先 tag 成目标引用，再推送（用于「推送到储存库」）。
router.post('/push', (req, res) => {
  const id = (req.body && (req.body.id || req.body.image));
  const target = req.body && req.body.target;
  if (!id) return res.status(400).json({ error: 'id 必填' });
  const user = req.session && req.session.username;
  const task = tasks.createTask({ type: 'image.push', title: '推送镜像 ' + (target || id.slice(0, 18)), detail: { id, target } });
  (async () => {
    try {
      let ref;
      if (target) {
        await d.tagImage(id, target.trim());
        ref = target.trim();
      } else {
        const imgs = await d.listImages();
        const img = imgs.find((i) => i.Id === id) || imgs.find((i) => (i.RepoTags || []).some((t) => t === id));
        const tags = (img && img.RepoTags) || [];
        const withReg = tags.find((t) => {
          const f = t.split('/')[0];
          return f.includes('.') || f === 'localhost';
        });
        if (!withReg) {
          throw new Error('该镜像标签不含 registry 主机（如 docker.1panel.live/ 或 用户名/），无法直接推送。请使用「推送到储存库」并填写完整目标引用（如 registry/namespace/repo:tag）');
        }
        ref = withReg;
      }
      await d.pushImage(ref, (line) => { tasks.appendLog(task.id, line); });
      audit(user, 'image.push', ref);
      tasks.finishTask(task.id, { status: 'success' });
    } catch (e) {
      tasks.finishTask(task.id, { status: 'error', error: e.message });
    }
  })();
  res.json({ ok: true, taskId: task.id });
});

// 导出镜像为 tar 归档（docker save），流式下载。
router.get('/export/:id', asyncHandler(async (req, res) => {
  const id = req.params.id;
  let ref = (id || 'image').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40);
  try {
    const info = await d.inspectImage(id);
    if (info && info.RepoTags && info.RepoTags.length) {
      ref = info.RepoTags[0].replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
    }
  } catch (_) { /* keep default */ }
  const stream = await d.docker.getImage(id).get();
  res.setHeader('Content-Type', 'application/x-tar');
  res.setHeader('Content-Disposition', `attachment; filename="image_${ref}.tar"`);
  stream.on('error', (e) => {
    if (!res.headersSent) res.status(500).json({ error: e.message });
    else res.destroy();
  });
  stream.pipe(res);
}));

// 提取镜像根文件系统为 tar（docker create + export + rm），流式下载。
router.get('/extract/:id', asyncHandler(async (req, res) => {
  const id = req.params.id;
  let ref = (id || 'rootfs').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40);
  try {
    const info = await d.inspectImage(id);
    if (info && info.RepoTags && info.RepoTags.length) {
      ref = info.RepoTags[0].replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
    }
  } catch (_) { /* keep default */ }
  const container = await d.docker.createContainer({ Image: id, Cmd: ['true'], Tty: true, AttachStdout: false, AttachStderr: false });
  const stream = await container.export();
  res.setHeader('Content-Type', 'application/x-tar');
  res.setHeader('Content-Disposition', `attachment; filename="rootfs_${ref}.tar"`);
  let cleaned = false;
  const cleanup = () => { if (cleaned) return; cleaned = true; container.remove({ force: true }).catch(() => {}); };
  stream.on('end', cleanup);
  stream.on('error', (e) => { cleanup(); if (!res.headersSent) res.status(500).json({ error: e.message }); else res.destroy(); });
  res.on('close', cleanup);
  stream.pipe(res);
}));

// 通过浏览器上传 tar 文件，执行 docker load 导入镜像。
// 文件以原始字节流式写入临时文件，再交给 loadImageFromFile（走 WSL docker CLI）。
router.post('/import', (req, res) => {
  const tmp = path.join(require('os').tmpdir(), 'wslmgr-import-' + Date.now() + '.tar');
  const ws = fs.createWriteStream(tmp);
  req.pipe(ws);
  ws.on('error', (e) => { if (!res.headersSent) res.status(500).json({ error: '写入临时文件失败: ' + e.message }); });
  ws.on('finish', () => {
    const user = req.session && req.session.username;
    const task = tasks.createTask({ type: 'image.import', title: '导入镜像（docker load）', detail: { file: tmp } });
    (async () => {
      try {
        await d.loadImageFromFile(tmp, (line) => tasks.appendLog(task.id, line));
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

// 从一段 Dockerfile 文本构建镜像（docker build，构建上下文为临时目录）。
router.post('/build', (req, res) => {
  const { dockerfile, tag, buildArgs } = req.body || {};
  if (!dockerfile || !dockerfile.trim()) return res.status(400).json({ error: 'dockerfile 必填' });
  if (!tag || !tag.trim()) return res.status(400).json({ error: 'tag 必填' });
  const user = req.session && req.session.username;
  const task = tasks.createTask({ type: 'image.build', title: '构建镜像 ' + tag.trim(), detail: { tag: tag.trim() } });
  (async () => {
    try {
      await d.buildImageFromDockerfile({ dockerfile, tag: tag.trim(), buildArgs }, (line) => tasks.appendLog(task.id, line));
      audit(user, 'image.build', tag.trim());
      tasks.finishTask(task.id, { status: 'success' });
    } catch (e) {
      tasks.finishTask(task.id, { status: 'error', error: e.message });
    }
  })();
  res.json({ ok: true, taskId: task.id });
});

module.exports = router;
