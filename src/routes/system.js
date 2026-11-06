// System-wide maintenance: docker system prune (unified cleanup) + system df (disk usage).
// These are operator actions, but not destructive-by-default: prune only removes
// stopped containers / dangling images / unused networks unless the caller opts in
// to `-a` (all images) / `--volumes`.
const express = require('express');
const d = require('../docker');
const tasks = require('../tasks');
const { asyncHandler, audit } = require('./util');

const router = express.Router();

router.get('/df', asyncHandler(async (req, res) => {
  res.json(await d.systemDf());
}));

// prune 接受 { all: bool, volumes: bool }。默认只清已停止容器+悬空镜像+未用网络。
router.post('/prune', (req, res) => {
  const user = req.session && req.session.username;
  const body = req.body || {};
  const all = !!body.all;
  const volumes = !!body.volumes;
  const task = tasks.runTask(
    { type: 'system.prune', title: '系统清理' + (all ? '(含全部镜像)' : '') + (volumes ? '(含卷)' : ''), detail: { all, volumes } },
    async (tk) => {
      tk.log('正在执行 docker system prune…');
      await d.systemPrune({ all, volumes });
      audit(user, 'system.prune', `all=${all} volumes=${volumes}`);
      tk.log('清理完成');
      return { ok: true };
    }
  );
  res.json({ ok: true, taskId: task.id });
});

module.exports = router;
