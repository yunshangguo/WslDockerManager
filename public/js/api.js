// API client for WslDockerManager. All calls carry the Bearer token from localStorage.
const TOKEN_KEY = 'wsldocker_mgr_token';

export function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
export function setToken(t) { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }
export function hasToken() { return !!getToken(); }

async function req(method, path, body, opts = {}) {
  const headers = {};
  const tk = getToken();
  if (tk) headers['Authorization'] = 'Bearer ' + tk;
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
  const init = { method, headers };
  if (body !== undefined && body !== null) init.body = JSON.stringify(body);
  let resp;
  try {
    resp = await fetch(path, init);
  } catch (e) {
    throw new Error('网络错误: ' + e.message);
  }
  if (resp.status === 401) {
    setToken('');
    throw new Error('未授权，请重新登录');
  }
  if (opts.raw) {
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.text();
  }
  const text = await resp.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
  if (!resp.ok) {
    const msg = (data && (data.error || data.message)) ? (data.error || data.message) : ('HTTP ' + resp.status);
    throw new Error(msg);
  }
  return data;
}

// Download a binary stream (image/rootfs tar) with the auth token, triggering a
// browser save-as dialog. Returns nothing; throws on HTTP error.
async function downloadStream(url, filename) {
  const headers = {};
  const tk = getToken();
  if (tk) headers['Authorization'] = 'Bearer ' + tk;
  let resp;
  try {
    resp = await fetch(url, { headers });
  } catch (e) {
    throw new Error('网络错误: ' + e.message);
  }
  if (!resp.ok) {
    let msg = 'HTTP ' + resp.status;
    try { const j = await resp.json(); if (j && j.error) msg = j.error; } catch (_) {}
    throw new Error(msg);
  }
  const blob = await resp.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename || 'download.tar';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export const api = {
  login: (u, p) => req('POST', '/api/auth/login', { username: u, password: p }),
  logout: () => req('POST', '/api/auth/logout'),
  health: () => req('GET', '/api/health'),
  session: () => req('GET', '/api/session'),
  diagnose: () => req('GET', '/api/diagnose'),
  // 环境前置依赖检测（虚拟化/WSL/Debian/Docker/配置项是否就绪）
  getPrereqs: (refresh) => req('GET', '/api/prereqs' + (refresh ? '?refresh=1' : '')),
  // 一键安装并自动配置运行环境（后台任务，返回 taskId）
  installPrereqs: () => req('POST', '/api/prereqs/install'),
  // 单独创建/重建保活计划任务（无需重跑整个安装向导）
  createKeepAlive: () => req('POST', '/api/prereqs/keepalive'),

  // containers
  listContainers: () => req('GET', '/api/containers'),
  containerStatsAll: (ids) => req('GET', `/api/containers/stats?ids=${encodeURIComponent((ids || []).join(','))}`),
  inspectContainer: (id) => req('GET', `/api/containers/${id}`),
  containerAction: (id, action, body) => req('POST', `/api/containers/${id}/${action}`, body || {}),
  removeContainer: (id, opts = {}) => {
    const q = new URLSearchParams();
    if (opts.force) q.set('force', '1');
    if (opts.v) q.set('v', '1');
    const s = q.toString();
    return req('DELETE', `/api/containers/${id}${s ? '?' + s : ''}`);
  },
  containerLogs: (id, opts = {}) => req('GET', `/api/containers/${id}/logs?tail=${opts.tail || 100}&timestamps=${opts.timestamps ? 1 : 0}`, null, { raw: true }),
  containerLogsText: (id, opts = {}) => req('GET', '/api/containers/' + id + '/logs?tail=' + (opts.tail != null ? opts.tail : 100) + '&timestamps=' + (opts.timestamps ? 1 : 0), null, { raw: true }).then((t) => {
    const d = JSON.parse(t);
    return (d && d.frames) ? d.frames.map((f) => f.text).join('') : (typeof t === 'string' ? t : '');
  }),
  containerExec: (id, cmd) => req('POST', `/api/containers/${id}/exec`, { cmd }),
  updateContainerImage: (id) => req('POST', `/api/containers/${id}/update`),
  containerRecreate: (id) => req('POST', `/api/containers/${id}/recreate`),
  configureContainer: (id, body) => req('POST', `/api/containers/${id}/configure`, body),
  createContainer: (spec) => req('POST', '/api/containers', spec),
  renameContainer: (id, name) => req('POST', `/api/containers/${id}/rename`, { name }),
  // 实时修改运行时配置（CPU/内存/重启策略），不重建容器
  updateContainerConfig: (id, body) => req('POST', `/api/containers/${id}/update-config`, body),
  // 将容器提交为镜像
  commitContainer: (id, body) => req('POST', `/api/containers/${id}/commit`, body),
  pruneContainers: () => req('POST', '/api/containers/prune'),
  batchContainers: (ids, action) => req('POST', '/api/containers/batch', { ids, action }),
  // 镜像导入：以原始字节（tar）POST 到后端，由后端 docker load 落地
  importImage: (file) => new Promise((resolve, reject) => {
    const headers = {};
    const tk = getToken();
    if (tk) headers['Authorization'] = 'Bearer ' + tk;
    headers['Content-Type'] = 'application/octet-stream';
    fetch('/api/images/import', { method: 'POST', headers, body: file })
      .then((resp) => {
        if (!resp.ok) return resp.text().then((t) => { let m = 'HTTP ' + resp.status; try { const j = JSON.parse(t); if (j && j.error) m = j.error; } catch (_) {} throw new Error(m); });
        return resp.json();
      })
      .then(resolve).catch(reject);
  }),

  // images
  listImages: () => req('GET', '/api/images'),
  inspectImage: (id) => req('GET', `/api/images/${encodeURIComponent(id)}`),
  // 镜像更新检测：读取上次结果 / 触发一次后台检测
  getImageUpdates: () => req('GET', '/api/images/updates'),
  checkImageUpdates: () => req('POST', '/api/images/updates/check'),
  removeImage: (id, force = true) => req('DELETE', `/api/images/${id}?force=${force ? 1 : 0}`),
  pullImage: (repoTag, registry) => req('POST', '/api/images/pull', registry ? { repoTag, registry } : { repoTag }),
  pruneImages: () => req('POST', '/api/images/prune'),
  // 从 Dockerfile 文本构建镜像
  buildImageFromDockerfile: (dockerfile, tag, buildArgs) => req('POST', '/api/images/build', { dockerfile, tag, buildArgs }),
  tagImage: (id, target) => req('POST', '/api/images/tag', { id, target }),
  pushImage: (id, target) => req('POST', '/api/images/push', target ? { id, target } : { id }),
  exportImage: (id, filename) => downloadStream(`/api/images/export/${encodeURIComponent(id)}`, filename || `image_${id.slice(0, 12)}.tar`),
  extractImage: (id, filename) => downloadStream(`/api/images/extract/${encodeURIComponent(id)}`, filename || `rootfs_${id.slice(0, 12)}.tar`),

  // volumes
  listVolumes: () => req('GET', '/api/volumes'),
  removeVolume: (name) => req('DELETE', `/api/volumes/${encodeURIComponent(name)}`),
  pruneVolumes: () => req('POST', '/api/volumes/prune'),
  createVolume: (spec) => req('POST', '/api/volumes', spec),
  backupVolume: (name, filename) => downloadStream(`/api/volumes/${encodeURIComponent(name)}/backup`, filename || `${name}.tar.gz`),
  // 上传 tar.gz 恢复卷内容
  restoreVolume: (name, file) => new Promise((resolve, reject) => {
    const headers = {};
    const tk = getToken();
    if (tk) headers['Authorization'] = 'Bearer ' + tk;
    headers['Content-Type'] = 'application/octet-stream';
    fetch(`/api/volumes/${encodeURIComponent(name)}/restore`, { method: 'POST', headers, body: file })
      .then((resp) => {
        if (!resp.ok) return resp.text().then((t) => { let m = 'HTTP ' + resp.status; try { const j = JSON.parse(t); if (j && j.error) m = j.error; } catch (_) {} throw new Error(m); });
        return resp.json();
      })
      .then(resolve).catch(reject);
  }),

  // networks
  listNetworks: () => req('GET', '/api/networks'),
  removeNetwork: (id) => req('DELETE', `/api/networks/${id}`),
  pruneNetworks: () => req('POST', '/api/networks/prune'),
  createNetwork: (spec) => req('POST', '/api/networks', spec),
  networkConnect: (id, container, ipv4) => req('POST', `/api/networks/${id}/connect`, ipv4 ? { container, ipv4 } : { container }),
  networkDisconnect: (id, container) => req('POST', `/api/networks/${id}/disconnect`, { container }),

  // host
  hostOverview: () => req('GET', '/api/host/overview'),
  hostInfo: () => req('GET', '/api/host/info'),
  hostVersion: () => req('GET', '/api/host/version'),
  hostResources: () => req('GET', '/api/host/resources'),

  // compose
  listStacks: () => req('GET', '/api/compose'),
  getStack: (name) => req('GET', `/api/compose/${encodeURIComponent(name)}`),
  createStack: (name, content) => req('POST', '/api/compose', { name, content }),
  updateStack: (name, content) => req('PUT', `/api/compose/${encodeURIComponent(name)}`, { content }),
  stackAction: (name, action) => req('POST', `/api/compose/${encodeURIComponent(name)}/${action}`),
  stackLogs: (name, opts = {}) => req('GET', `/api/compose/${encodeURIComponent(name)}/logs?tail=${opts.tail || 200}${opts.service ? '&service=' + encodeURIComponent(opts.service) : ''}`, null, { raw: true }),
  deleteStack: (name) => req('DELETE', `/api/compose/${encodeURIComponent(name)}`),

  // util
  win2wsl: (p) => req('GET', `/api/util/win2wsl?path=${encodeURIComponent(p)}`),
  fsList: (p) => req('GET', `/api/util/fs-list?path=${encodeURIComponent(p || '')}`),


  // P1: 镜像历史(layers)
  imageHistory: (id) => req('GET', `/api/images/${encodeURIComponent(id)}/history`).then((d) => (d && d.history) ? d.history : []),
  // P1: 卷/网络 inspect（后端路由已存在）
  inspectVolume: (name) => req('GET', `/api/volumes/${encodeURIComponent(name)}`),
  inspectNetwork: (id) => req('GET', `/api/networks/${encodeURIComponent(id)}`),
  // P2: 审计日志读取
  listAudit: (limit = 200) => req('GET', `/api/audit?limit=${limit}`).then((d) => (d && d.lines) ? d.lines : []),
  // 审计日志导出（纯文本下载）
  exportAudit: () => downloadStream('/api/audit/export', 'audit.log'),
  // 系统清理（docker system prune / df），仅管理员
  systemPrune: (opts = {}) => req('POST', '/api/system/prune', opts),
  systemDf: () => req('GET', '/api/system/df'),
  // WSL 资源配置（.wslconfig）
  getWslConfig: () => req('GET', '/api/wslconfig'),
  setWslConfig: (patch) => req('PUT', '/api/wslconfig', patch),

  // background tasks
  listTasks: () => req('GET', '/api/tasks'),
  getTask: (id) => req('GET', `/api/tasks/${encodeURIComponent(id)}`),
  clearTasks: () => req('DELETE', '/api/tasks'),
  removeTask: (id) => req('DELETE', `/api/tasks/${encodeURIComponent(id)}`),

  // settings
  restartDocker: () => req('POST', '/api/settings/docker/restart'),
  // 升级 WSL 内的 Docker 引擎（后台任务，返回 taskId）
  updateDockerEngine: () => req('POST', '/api/settings/docker/update'),
  diagnoseMirror: () => req('GET', '/api/settings/diagnose'),
  // 镜像源管理（daemon.json 的 registry-mirrors，每个镜像源可单独登录）
  getMirrorSources: () => req('GET', '/api/settings/mirror-sources'),
  addMirrorSource: (payload) => req('POST', '/api/settings/mirror-sources', payload),
  removeMirrorSource: (payload) => req('DELETE', '/api/settings/mirror-sources', payload),
  // 镜像源登录 / 退出（docker login / logout）；列出已登录镜像站
  registryLogin: (payload) => req('POST', '/api/settings/registry/login', payload),
  listRegistries: () => req('GET', '/api/settings/registry/list'),
  registryLogout: (payload) => req('POST', '/api/settings/registry/logout', payload),
  // 镜像更新扫描设置（扫描频率 + 自动更新策略）
  getUpdateSettings: () => req('GET', '/api/settings/updates'),
  saveUpdateSettings: (patch) => req('POST', '/api/settings/updates', patch),

  // users (admin only)
  listUsers: () => req('GET', '/api/users'),
  createUser: ({ username, password, role }) => req('POST', '/api/users', { username, password, role }),
  updateUser: (username, body) => req('PUT', `/api/users/${encodeURIComponent(username)}`, body),
  resetUserPassword: (username, password) => req('PUT', `/api/users/${encodeURIComponent(username)}`, { password }),
  deleteUser: (username) => req('DELETE', `/api/users/${encodeURIComponent(username)}`),
};
