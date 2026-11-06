import { api, getToken, setToken } from './api.js?v=20261106f';
import { toast, fmtBytes, fmtPct } from './ui.js?v=20261106f';
import { TaskDock, taskStore } from './tasks.js?v=20261106f';
import { DashboardView, ContainersView, ImagesView, VolumesView, NetworksView, StacksView, TasksView, ContainerLogsView, UsersView, AuditView, InteractiveTerminalView, SettingsView, SetupView, stateBadge } from './views.js?v=20261106f';

const { createApp } = Vue; // Vue is loaded globally via CDN in index.html

const ROUTES = {
  dashboard: DashboardView,
  containers: ContainersView,
  images: ImagesView,
  volumes: VolumesView,
  networks: NetworksView,
  stacks: StacksView,
  tasks: TasksView,
  setup: SetupView,
  settings: SettingsView,
  clogs: ContainerLogsView,
  users: UsersView,
  audit: AuditView,
  term: InteractiveTerminalView,
};

const NAV = [
  { key: 'dashboard', label: '概览' },
  { key: 'containers', label: '容器' },
  { key: 'images', label: '镜像' },
  { key: 'volumes', label: '卷' },
  { key: 'networks', label: '网络' },
  { key: 'stacks', label: 'Compose 栈' },
  { key: 'tasks', label: '后台任务' },
  { key: 'setup', label: '环境检测' },
  { key: 'settings', label: '设置', admin: true },
  { key: 'users', label: '用户管理', admin: true },
  { key: 'audit', label: '审计日志', admin: true },
];

const App = {
  data() {
    return {
      token: getToken(),
      user: null,
      route: 'dashboard',
      routeParam: null,
      username: '',
      password: '',
      loginErr: '',
      loggingIn: false,
      // 启动自检：环境前置依赖（虚拟化/WSL/Debian/Docker/配置）是否就绪；不就绪则顶部横幅提示
      prereq: null,
      prereqDismissed: false,
    };
  },
  computed: {
    loggedIn() { return !!this.token; },
    currentView() { return ROUTES[this.route] || DashboardView; },
    navItems() {
      const isAdmin = !!(this.user && this.user.isAdmin);
      return NAV.filter((n) => !n.admin || isAdmin);
    },
    // 后台运行中的任务数（由 TaskDock 轮询写入共享 store），用于侧栏红点徽标
    taskRunning() {
      const t = (taskStore && taskStore.tasks) || [];
      return t.filter((x) => x.status === 'running').length;
    },
    // 启动自检：缺失/需更新的前置依赖数量（用于顶部横幅）
    prereqMissing() {
      if (!this.prereq || !this.prereq.components) return 0;
      return this.prereq.components.filter((c) => ['missing', 'outdated', 'misconfigured'].includes(c.status)).length;
    },
  },
  mounted() {
    this.route = this.parseHash();
    window.addEventListener('hashchange', () => { this.route = this.parseHash(); });
    if (this.token) this.verify();
  },
  methods: {
    parseHash() {
      const h = (location.hash || '').replace(/^#\/?/, '');
      const seg = h.split('/');
      if (seg[0] === 'clogs') { this.routeParam = seg[1] || null; return 'clogs'; }
      if (seg[0] === 'term') { this.routeParam = seg[1] || null; return 'term'; }
      this.routeParam = null;
      return ROUTES[seg[0]] ? seg[0] : 'dashboard';
    },
    nav(r) { location.hash = '#/' + r; this.route = r; },
    async verify() {
      try {
        this.user = await api.session();
        // 登录成功后做一次启动自检（虚拟化/WSL/Debian/Docker/配置是否就绪），用于顶部横幅
        this.loadPrereq();
      }
      catch (e) {
        // Only clear the session on a real auth failure (401). Transient network
        // errors must NOT log the user out — that was a major annoyance.
        if (e && e.message && e.message.includes('未授权')) { setToken(''); this.token = ''; }
      }
    },
    async loadPrereq() {
      try { this.prereq = await api.getPrereqs(); } catch (_) {}
    },
    async login() {
      this.loginErr = ''; this.loggingIn = true;
      try {
        const r = await api.login(this.username, this.password);
        setToken(r.token); this.token = r.token; this.user = r;
        this.route = this.parseHash();
        toast('登录成功', 'ok');
      } catch (e) { this.loginErr = e.message; }
      finally { this.loggingIn = false; }
    },
    async logout() {
      try { await api.logout(); } catch (e) {}
      setToken(''); this.token = ''; this.user = null; location.hash = '';
      toast('已退出登录');
    },
    quitApp() {
      // Fully quit the desktop app (window + tray + backend). Only available inside
      // the Electron shell; in a plain browser this action has no meaning.
      if (window.electronAPI && typeof window.electronAPI.quitApp === 'function') {
        window.electronAPI.quitApp();
      } else {
        toast('此操作仅在桌面客户端可用');
      }
    },
  },
  template: `
  <div v-if="!loggedIn" class="login-wrap">
    <div class="login-card">
      <h1>WslDockerManager</h1>
      <p>管理 WSL2 内的 Docker（无 Docker Desktop）</p>
      <label class="fld"><span>用户名</span><input v-model="username" @keyup.enter="login" autofocus></label>
      <label class="fld"><span>密码</span><input type="password" v-model="password" @keyup.enter="login"></label>
      <div v-if="loginErr" style="color:#e5484d;font-size:13px;margin-bottom:10px">{{ loginErr }}</div>
      <button class="btn primary" style="width:100%" :disabled="loggingIn" @click="login">{{ loggingIn ? '登录中…' : '登录' }}</button>
    </div>
  </div>

  <div v-else class="shell">
    <div class="sidebar">
      <div class="brand">WslDockerManager<small>WSL2 · Docker Engine</small></div>
      <div v-for="n in navItems" :key="n.key" class="nav-item" :class="{active: route===n.key}" @click="nav(n.key)">
        <span>{{ n.label }}</span>
        <span v-if="n.key==='tasks' && taskRunning" class="nav-badge" :title="taskRunning + ' 个后台任务进行中'">{{ taskRunning }}</span>
      </div>
      <div class="spacer"></div>
      <div class="userbox">
        <div>登录用户：<b>{{ (user&&user.username)||'admin' }}</b></div>
        <div v-if="user&&user.isAdmin" style="color:#2fa66b">管理员</div>
        <div style="margin-top:8px;cursor:pointer;color:#9aa3b5" @click="logout">退出登录</div>
        <div style="margin-top:4px;cursor:pointer;color:#9aa3b5" @click="quitApp">退出程序</div>
      </div>
    </div>
    <div class="content">
      <div v-if="prereq && prereqMissing > 0 && !prereqDismissed" class="ready-banner">
        <span class="rb-icon">⚠</span>
        <span class="rb-text">运行环境未就绪：检测到 <b>{{ prereqMissing }}</b> 项需要安装/配置（虚拟化 / WSL / Debian / Docker / 必要设置）。</span>
        <a class="rb-link" href="#/setup" @click.prevent="prereqDismissed = false; nav('setup')">前往「环境检测」一键安装</a>
        <button class="rb-close" @click="prereqDismissed = true" title="忽略">×</button>
      </div>
      <component :is="currentView"></component>
    </div>
    <teleport to="body"><task-dock class="hidden-fab"></task-dock></teleport>
  </div>
  `,
};

// Register module-scope helpers as global properties so that option-API
// templates (which cannot see module-level imports) can call them. If a
// template references an identifier that isn't a method/prop/globalProperty,
// Vue throws at render time and the whole view goes blank while the sidebar
// (rendered by App) keeps showing — that is the "only menu bar" symptom.
const app = createApp(App).component('task-dock', TaskDock);
app.config.globalProperties.fmtBytes = fmtBytes;
app.config.globalProperties.fmtPct = fmtPct;
app.config.globalProperties.toast = toast;
app.config.globalProperties.stateBadge = stateBadge;
// Show the root-cause error in a persistent, copyable panel. The dev build
// (vue.global.js) reports the real message; the prod build masks it as
// "subTree". This replaces the silent white-screen / misleading single toast.
function showFatal(msg, info, stack) {
  try {
    let box = document.getElementById('fatal-error');
    if (!box) {
      box = document.createElement('div');
      box.id = 'fatal-error';
      box.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;max-height:42vh;overflow:auto;z-index:99999;background:#2b0d0e;color:#ffd7d9;border:1px solid #e5484d;border-radius:10px;padding:14px 16px;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;box-shadow:0 8px 30px rgba(0,0,0,.45)';
      document.body.appendChild(box);
    }
    const head = '【页面渲染出错' + (info ? ' · ' + info : '') + '】\n';
    const tail = stack ? '\n\n' + String(stack).split('\n').slice(0, 6).join('\n') : '';
    box.textContent = head + msg + tail + '\n\n（请把以上内容发给我，即可精准定位修复）';
  } catch (_) {}
}

// Surface render/runtime errors instead of silently blanking the page.
// Keep the FIRST (root-cause) error and ignore Vue's secondary internal
// "subTree" masking error so the real message is what the user sees.
const vueErrors = (window.__vueErrors = []);
let rootErr = null;
app.config.errorHandler = (err, _instance, info) => {
  console.error('[Vue error]', err, info, _instance);
  const msg = (err && err.message) ? err.message : String(err);
  vueErrors.push({ msg, info, at: new Date().toISOString() });
  if (/subTree|reading 'subTree'/.test(msg)) {
    if (rootErr) return; // already showing the real root cause
  }
  if (!rootErr) rootErr = { msg, info, stack: err && err.stack };
  showFatal(rootErr.msg, rootErr.info, rootErr.stack);
};
app.mount('#app');
