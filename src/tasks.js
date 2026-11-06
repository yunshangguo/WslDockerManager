// In-memory background task registry for long-running Docker operations
// (pull / remove / prune / compose up ...). Each task carries a status,
// an optional 0-100 progress hint, and a log of timestamped events that the
// UI renders in the task dock.
const { localizeError } = require('./routes/util');
const tasks = new Map();
const MAX_TASKS = 300;

function ts() { return Date.now(); }

function createTask({ type, title, detail = {} }) {
  const id = 't_' + ts().toString(36) + Math.random().toString(36).slice(2, 7);
  const task = {
    id,
    type,
    title,
    status: 'running',
    createdAt: ts(),
    updatedAt: ts(),
    detail,
    progress: null,
    log: [],
    error: null,
    result: null,
  };
  tasks.set(id, task);
  if (tasks.size > MAX_TASKS) {
    // evict the oldest finished task to bound memory
    const oldest = [...tasks.values()]
      .filter((t) => t.status !== 'running')
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) tasks.delete(oldest.id);
  }
  return task;
}

function appendLog(id, msg, level = 'info') {
  const t = tasks.get(id);
  if (!t) return;
  t.log.push({ t: ts(), msg: String(msg), level });
  if (t.log.length > 500) t.log.splice(0, t.log.length - 500);
  t.updatedAt = ts();
}

function setProgress(id, pct) {
  const t = tasks.get(id);
  if (!t) return;
  let p = Number(pct);
  if (isNaN(p)) return;
  p = Math.max(0, Math.min(100, p));
  t.progress = p;
  t.updatedAt = ts();
}

function finishTask(id, { status, error, result } = {}) {
  const t = tasks.get(id);
  if (!t) return;
  t.status = status || 'success';
  t.updatedAt = ts();
  if (error != null) t.error = localizeError(error);
  if (result !== undefined) t.result = result;
  if (t.status === 'success' && t.progress == null) t.progress = 100;
}

// Connection failures (dockerd down / WSL not started) are transient and
// self-healable. If the worker throws an ECONNREFUSED-class error we bring the
// daemon up and retry the WHOLE worker once. Because dockerode throws on
// connect, the first attempt did no real work, so retrying is safe/idempotent.
const CONN_ERR_RE = /ECONNREFUSED|refused|socket hang up|daemon|connect.*2375/i;
function isConnErr(e) { return CONN_ERR_RE.test((e && e.message) || ''); }

// Create a task and run fn(helpers) in the background. The route returns
// immediately with the task id; fn may call helpers.log(msg, level),
// helpers.progress(pct) and helpers.finish(patch). On success/throw the task
// is auto-finished.
function runTask({ type, title, detail }, fn) {
  const task = createTask({ type, title, detail });
  const helpers = {
    log: (m, l) => appendLog(task.id, m, l),
    progress: (p) => setProgress(task.id, p),
    finish: (patch) => finishTask(task.id, patch),
  };
  const runOnce = async () => {
    try {
      return await fn(helpers);
    } catch (e) {
      if (isConnErr(e)) {
        helpers.log('Docker 守护进程未响应，正在自动拉起后重试…');
        await ensureDockerd(true).catch(() => {});
        return await fn(helpers); // retry once after dockerd is back
      }
      throw e;
    }
  };
  Promise.resolve()
    .then(runOnce)
    .then((result) => finishTask(task.id, { status: 'success', result }))
    .catch((e) => finishTask(task.id, { status: 'error', error: (e && e.message) || String(e) }));
  return task;
}

function listTasks() {
  return [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
}

function getTask(id) { return tasks.get(id) || null; }

function clearFinished() {
  for (const [k, v] of tasks) if (v.status !== 'running') tasks.delete(k);
}

function removeTask(id) { tasks.delete(id); }

module.exports = {
  createTask,
  appendLog,
  setProgress,
  finishTask,
  runTask,
  listTasks,
  getTask,
  clearFinished,
  removeTask,
};
