// WslDockerManager frontend views. Plain Vue 3 options-API components.
// Each view talks to the api client directly. No build step required.
import { api } from './api.js';
import { whenTaskDone } from './tasks.js';
import { toast, confirmDanger, fmtBytes, fmtPct } from './ui.js';

function fmtDate(sec) {
  if (!sec) return '-';
  const d = new Date(sec * 1000);
  return d.toLocaleString();
}
export function stateBadge(s) {
  s = (s || '').toLowerCase();
  if (s.includes('run') || s.includes('up')) return 'running';
  if (s.includes('paus')) return 'paused';
  if (s.includes('exited') || s.includes('down')) return 'exited';
  if (s.includes('partial')) return 'other';
  return 'other';
}

// 圆环仪表盘组件：pct 为 0-100 百分比，中心显示数值，下方显示基础数据。
// 颜色随占用率变化（绿→橙→红）。在概览页用于 CPU / 内存 / 磁盘占用展示。
const Gauge = {
  props: {
    pct: { type: Number, default: 0 },
    label: { type: String, default: '' },
    base: { type: String, default: '' },
  },
  computed: {
    circumference() { return 2 * Math.PI * 52; },
    clamped() { return Math.max(0, Math.min(100, Number(this.pct) || 0)); },
    offset() { return this.circumference * (1 - this.clamped / 100); },
    color() { return this.clamped >= 90 ? '#e5484d' : this.clamped >= 70 ? '#f5a623' : '#2fa66b'; },
  },
  template: `
  <div class="gauge">
    <div class="gauge-ring">
      <svg viewBox="0 0 120 120" class="gauge-svg">
        <circle class="g-track" cx="60" cy="60" r="52" fill="none" stroke-width="11"></circle>
        <circle class="g-fill" cx="60" cy="60" r="52" fill="none" stroke-width="11"
          :stroke="color" :stroke-dasharray="circumference" :stroke-dashoffset="offset"
          stroke-linecap="round" transform="rotate(-90 60 60)"></circle>
      </svg>
      <div class="gauge-center">
        <div class="g-pct" :style="{ color }">{{ Math.round(clamped) }}<span class="g-unit">%</span></div>
        <div class="g-label">{{ label }}</div>
      </div>
    </div>
    <div class="g-base" v-if="base">{{ base }}</div>
  </div>`,
};

// ---------------------------------------------------------------- Dashboard
export const DashboardView = {
  data() {
    return { overview: undefined, loading: false, err: '', info: null, infoErr: '', restarting: false, restartMsg: '', df: null, dfErr: '', pruning: false, pruneMsg: '', updating: false, updateMsg: '',
      // 引擎更新进度：轮询后台任务，卡内显示进度条 + 实时日志
      updateTask: null, updatePoll: null,
      // 连接诊断：连不上 WSL/Docker 时自动诊断原因
      diag: null, diagLoading: false, diagErr: '' };
  },
  components: { Gauge },
  mounted() { this.load(); this.loadDf(); },
  beforeUnmount() { if (this.updatePoll) clearTimeout(this.updatePoll); },
  methods: {
    async load() {
      this.loading = true; this.err = ''; this.overview = undefined;
      try {
        const o = await api.hostOverview();
        // api may resolve to null/undefined if backend returned empty body
        this.overview = o || null;
      } catch (e) {
        this.err = e.message;
        // 连不上 WSL/Docker 时自动跑一次连接诊断，把"为什么连不上"展示出来
        this.runDiagnose();
      }
      finally { this.loading = false; }
      // load settings-style Docker info (best-effort, never fails the page)
      this.infoErr = '';
      try {
        const [info, ver] = await Promise.all([api.hostInfo().catch(() => null), api.hostVersion().catch(() => null)]);
        this.info = Object.assign({}, ver || {}, info || {});
      } catch (e) { this.infoErr = e.message; }
    },
    async restartDocker() {
      if (!confirmDanger('确认重启 Docker 引擎？所有容器将被停止后由 Docker 重新拉起（耗时约数十秒），期间服务会短暂中断。')) return;
      this.restarting = true; this.restartMsg = '';
      try { const r = await api.restartDocker(); this.restartMsg = (r && r.message) || '重启指令已下发'; toast('Docker 重启指令已下发', 'ok'); }
      catch (e) { this.restartMsg = '失败：' + e.message; toast('重启失败：' + e.message, 'err'); }
      finally { this.restarting = false; }
    },
    // ---- 仪表盘数据 ----
    cpuPct() {
      const c = this.wsl().cpu || {};
      if (c.usagePct != null) return c.usagePct;
      if (c.usageError) return 0;
      return 0;
    },
    memPct() {
      const m = this.wsl().memory || {};
      if (m.usedPct != null) return m.usedPct;
      if (m.totalBytes) return Math.round((m.usedBytes / m.totalBytes) * 100);
      return 0;
    },
    diskPct() { const d = this.disk(); return d ? Math.round(d.pct * 100) : 0; },
    cpuBase() {
      const c = this.wsl().cpu || {};
      const parts = [];
      if (c.model && c.model !== '未知') parts.push(c.model);
      if (c.cores != null) parts.push(c.cores + ' 核');
      if (c.load1 != null) parts.push('负载 ' + c.load1);
      if (c.arch) parts.push(c.arch);
      if (c.usageError) return 'CPU 占用率读取失败';
      return parts.join(' · ');
    },
    memBase() {
      const m = this.wsl().memory || {};
      if (m.usedBytes == null || m.totalBytes == null) return m.error ? '读取失败' : '-';
      return fmtBytes(m.usedBytes) + ' / ' + fmtBytes(m.totalBytes) + '（空闲 ' + fmtBytes(m.freeBytes || 0) + '）';
    },
    diskBase() {
      const d = this.disk();
      if (!d) return (this.wsl().disk && this.wsl().disk.error) ? '读取失败' : '-';
      return fmtBytes(d.used) + ' / ' + fmtBytes(d.total);
    },
    // 升级 WSL 内的 Docker 引擎：创建后台任务，并在本卡片内实时显示进度（进度条 + 日志）
    async updateEngine() {
      if (this.updateTask && this.updateTask.status === 'running') return; // 防止重复点击
      if (!confirmDanger('确认更新 Docker 引擎？将通过 apt 升级 WSL 内的 Docker 组件，升级期间 Docker 服务可能短暂重启，正在运行的容器会短暂中断。')) return;
      this.updating = true; this.updateMsg = ''; this.updateTask = { id: null, status: 'running', progress: 0, log: [], message: '', result: null };
      try {
        const r = await api.updateDockerEngine();
        const t = r && r.taskId;
        if (!t) { this.updateMsg = '创建更新任务失败（未返回任务 ID）'; return; }
        this.updateTask = { id: t, status: 'running', progress: 0, log: [], message: '', result: null };
        this.pollUpdateTask();
        toast('Docker 引擎更新任务已创建', 'ok');
      } catch (e) {
        this.updateMsg = '失败：' + e.message; toast('更新失败：' + e.message, 'err');
        this.updateTask = null;
      }
      finally { this.updating = false; }
    },
    // 轮询更新任务，把进度与日志写回 this.updateTask，完成后刷新概览
    pollUpdateTask() {
      if (!this.updateTask || !this.updateTask.id) return;
      const id = this.updateTask.id;
      if (this.updatePoll) clearTimeout(this.updatePoll);
      this.updatePoll = setTimeout(async () => {
        try {
          const t = await api.getTask(id);
          if (!t) return;
          this.updateTask = Object.assign({}, this.updateTask, {
            status: t.status, progress: (t.progress != null ? t.progress : this.updateTask.progress), log: t.log || [], message: t.message || '', result: t.result || null,
          });
          if (t.status === 'running') { this.pollUpdateTask(); return; }
          // 完成：展示结论并刷新概览
          if (t.status === 'success') {
            this.updateMsg = (t.result && t.result.upgraded)
              ? '更新完成，建议点「重启 Docker」应用新版本'
              : '已是最新版本，无需更新';
          } else {
            this.updateMsg = '更新失败：' + (t.error || t.message || '未知错误');
          }
          this.load();
        } catch (e) {
          // 瞬时轮询失败：继续轮询，最终会在超时/成功时收尾
          if (this.updateTask && this.updateTask.status === 'running') this.pollUpdateTask();
        }
      }, 1000);
    },
    // 运行连接诊断：连不上 WSL/Docker 时，查明是"没安装"还是"网络设置问题"
    async runDiagnose() {
      if (this.diagLoading) return;
      this.diagLoading = true; this.diagErr = ''; this.diag = null;
      try {
        const d = await api.diagnose();
        this.diag = d || null;
      } catch (e) {
        this.diagErr = e.message;
      }
      finally { this.diagLoading = false; }
    },
    ver() { return (this.overview && this.overview.version) || {}; },
    // 连接诊断结论 -> 中文标题
    diagStatusText() {
      const s = this.diag && this.diag.status;
      const map = {
        ok: '连接正常', wsl_missing: 'WSL 未安装', distro_missing: '未安装所需 WSL 发行版',
        distro_not_running: 'WSL 发行版未能启动', docker_not_installed: 'WSL 内未安装 Docker',
        dockerd_down: 'Docker 守护进程未启动', network_issue: '网络 / 端口配置问题',
      };
      if (this.diag && this.diag.ok) return map.ok;
      return map[s] || ('未知（' + (s || '?') + '）');
    },
    diagStatusClass() { return (this.diag && this.diag.ok) ? 'ok' : 'bad'; },
    eng() { return (this.overview && this.overview.engine) || {}; },
    wsl() { return (this.overview && this.overview.wsl) || {}; },
    memUsed() {
      const m = this.wsl().memory;
      if (!m || m.totalBytes == null) return null;
      return { used: m.usedBytes, total: m.totalBytes, pct: m.totalBytes ? m.usedBytes / m.totalBytes : 0 };
    },
    disk() {
      const d = this.wsl().disk;
      if (!d || d.totalBytes == null) return null;
      return { used: d.usedBytes, total: d.totalBytes, pct: d.totalBytes ? d.usedBytes / d.totalBytes : 0 };
    },
    // 概览页磁盘：每个真实挂载点一个圆圈（存储池天然是单一挂载，不拆成底层磁盘）
    disks() { return (this.wsl().disks || []).filter((d) => d && d.totalBytes); },
    diskLabel(d) {
      if (d.isPool) return '存储池';
      const dev = (d.device || d.mountpoint || '').toUpperCase();
      const m = /^([A-Z]):$/.exec(dev);
      if (m) return m[1] + ' 盘'; // 宿主机实际磁盘：C 盘 / D 盘 …
      if (dev === '/') return '系统盘';
      return d.mountpoint || d.device || '磁盘';
    },
    diskBase(d) {
      const s = fmtBytes(d.usedBytes) + ' / ' + fmtBytes(d.totalBytes);
      return d.isPool && d.mountpoint ? s + '（' + d.mountpoint + '）' : s;
    },
    async loadDf() {
      this.dfErr = '';
      try {
        const d = await api.systemDf();
        const sum = (arr) => (arr || []).reduce((a, x) => a + (x.size || 0), 0);
        const rec = (arr) => (arr || []).reduce((a, x) => a + (x.reclaimable || 0), 0);
        this.df = {
          imagesSize: sum(d.images), imagesReclaim: rec(d.images),
          containersSize: sum(d.containers), containersReclaim: rec(d.containers),
          volumesSize: sum(d.volumes), volumesReclaim: rec(d.volumes),
          buildCacheSize: sum(d.buildCache), buildCacheReclaim: rec(d.buildCache),
        };
      } catch (e) { this.dfErr = e.message; }
    },
    async doPrune(all, volumes) {
      if (!confirmDanger('确认执行系统清理？' + (all ? '（将清理所有未被容器引用的镜像）' : '') + (volumes ? '（将同时清理未使用卷，卷数据不可恢复）' : ''))) return;
      this.pruning = true; this.pruneMsg = '';
      try {
        const r = await api.systemPrune({ all, volumes });
        this.pruneMsg = '清理任务已创建，可在右下角任务栏查看进度';
        whenTaskDone(r.taskId, () => this.loadDf());
      } catch (e) { this.pruneMsg = '失败：' + e.message; toast('清理失败：' + e.message, 'err'); }
      finally { this.pruning = false; }
    },
  },
  template: `
  <div class="view scroll">
    <h2 class="page-title">概览</h2>
    <p class="page-sub">WSL2 内 Docker Engine 运行状态与宿主机资源</p>
    <div v-if="loading" class="center-pad"><span class="spinner"></span> 加载中…</div>
    <div v-else-if="err" class="empty">
      <div class="banner err">无法连接 Docker / WSL：{{ err }}</div>
      <p class="muted-sm">
        <button class="btn sm" @click="load">重试</button>
        <button class="btn sm" :disabled="diagLoading" @click="runDiagnose">{{ diagLoading ? '诊断中…' : '运行连接诊断' }}</button>
      </p>
      <div v-if="diagErr" class="muted-sm">诊断失败：{{ diagErr }}</div>
      <div v-if="diag" class="diag-box" :class="diagStatusClass()">
        <div class="diag-status" :class="diagStatusClass()">{{ diagStatusText() }}</div>
        <ul class="diag-steps">
          <li v-for="(s,i) in diag.steps" :key="i" class="diag-step" :class="s.ok ? 'ok' : 'bad'">
            <span class="diag-ico">{{ s.ok ? '✓' : '✗' }}</span>
            <span class="diag-name">{{ s.name }}</span>
            <span class="diag-detail">{{ s.detail }}</span>
          </li>
        </ul>
        <div v-if="diag.hints && diag.hints.length" class="diag-hints">
          <div class="diag-hint-title">排查建议：</div>
          <div v-for="(h,i) in diag.hints" :key="i" class="diag-hint">· {{ h }}</div>
        </div>
      </div>
    </div>
    <div v-else-if="!overview" class="empty">暂无数据（点刷新重试）<br><button class="btn sm" @click="load">刷新</button></div>
    <template v-else>
      <div v-if="eng().error || ver().error || wsl().error" class="banner warn">
        部分数据获取失败：{{ eng().error || ver().error || wsl().error }}
      </div>
      <div class="grid cols-4">
        <div class="stat">
          <div class="label">Docker 版本</div>
          <div class="value">{{ ver().Version || '-' }}</div>
          <small>API {{ ver().ApiVersion || '-' }}</small>
        </div>
        <div class="stat">
          <div class="label">引擎</div>
          <div class="value" style="font-size:18px">{{ eng().Name || 'Docker' }}</div>
          <small>OS {{ ver().Os || '-' }}/{{ ver().Arch || '-' }}</small>
        </div>
        <div class="stat">
          <div class="label">WSL CPU 核心</div>
          <div class="value">{{ wsl().cpu && wsl().cpu.cores != null ? wsl().cpu.cores : '-' }}</div>
          <small v-if="wsl().configuredMemoryLimit">限制 {{ wsl().configuredMemoryLimit }}</small>
        </div>
        <div class="stat">
          <div class="label">容器</div>
          <div class="value">{{ (eng().Containers != null ? eng().Containers : '-') }}</div>
          <small>运行 {{ eng().ContainersRunning }} / 暂停 {{ eng().ContainersPaused }}</small>
        </div>
      </div>
      <div class="card" style="margin-top:18px">
        <div class="toolbar"><b>WSL 资源占用</b><button class="btn sm" @click="load">刷新</button></div>
        <div class="gauge-row">
          <gauge :pct="cpuPct()" label="CPU" :base="cpuBase()"></gauge>
          <gauge :pct="memPct()" label="内存" :base="memBase()"></gauge>
          <template v-if="disks().length">
            <gauge v-for="d in disks()" :key="d.mountpoint" :pct="d.usedPct" :label="diskLabel(d)" :base="diskBase(d)"></gauge>
          </template>
          <gauge v-else :pct="diskPct()" label="磁盘" :base="diskBase()"></gauge>
        </div>
      </div>

      <div class="card" style="margin-top:18px">
        <div class="toolbar"><b>Docker 信息</b><button class="btn sm" @click="load">刷新</button></div>
        <div v-if="infoErr" class="empty">读取失败：{{ infoErr }}</div>
        <div v-else-if="!info" class="muted-sm" style="margin-top:8px">（点击刷新加载）</div>
        <div v-else class="kv">
          <div class="k">已停止</div><div>{{ info.ContainersStopped != null ? info.ContainersStopped : '-' }}</div>
          <div class="k">镜像数</div><div>{{ info.Images != null ? info.Images : '-' }}</div>
          <div class="k">存储驱动</div><div class="mono">{{ info.Driver || '-' }}</div>
          <div class="k">操作系统</div><div>{{ info.OperatingSystem || '-' }}</div>
        </div>
      </div>

      <div class="card" style="margin-top:18px">
        <div class="toolbar"><b>原始 JSON</b><button class="btn sm" @click="load">刷新</button></div>
        <div v-if="infoErr" class="empty">读取失败：{{ infoErr }}</div>
        <div v-else-if="!info" class="muted-sm" style="margin-top:8px">（点击刷新加载）</div>
        <pre v-else class="code-box raw-json">{{ JSON.stringify(info, null, 2) }}</pre>
      </div>

      <div class="card" style="margin-top:18px">
        <div class="toolbar"><b>系统清理与磁盘占用</b><button class="btn sm" @click="loadDf">刷新</button></div>
        <div v-if="dfErr" class="empty">读取失败：{{ dfErr }}</div>
        <div v-else-if="df" class="kv">
          <div class="k">镜像占用</div><div>{{ fmtBytes(df.imagesSize) }}（可回收 {{ fmtBytes(df.imagesReclaim) }}）</div>
          <div class="k">容器占用</div><div>{{ fmtBytes(df.containersSize) }}（可回收 {{ fmtBytes(df.containersReclaim) }}）</div>
          <div class="k">卷占用</div><div>{{ fmtBytes(df.volumesSize) }}（可回收 {{ fmtBytes(df.volumesReclaim) }}）</div>
          <div class="k">构建缓存</div><div>{{ fmtBytes(df.buildCacheSize) }}（可回收 {{ fmtBytes(df.buildCacheReclaim) }}）</div>
        </div>
        <div class="btn-row" style="margin-top:10px">
          <button class="btn" :disabled="pruning" @click="doPrune(false, false)">清理已停止容器/悬空镜像</button>
          <button class="btn" :disabled="pruning" @click="doPrune(true, false)">+ 全部未用镜像</button>
          <button class="btn danger" :disabled="pruning" @click="doPrune(false, true)">+ 卷</button>
        </div>
        <p v-if="pruneMsg" class="muted-sm" style="margin-top:8px">{{ pruneMsg }}</p>
      </div>

      <div class="card" style="margin-top:18px">
        <div class="toolbar"><b>Docker 引擎管理</b></div>
        <p class="muted-sm">用于 WSL2 内 Docker 卡死或网络异常时恢复。重启后所有容器会被停止再拉起，期间服务会短暂中断。</p>
        <div class="btn-row">
          <button class="btn danger" :disabled="restarting" @click="restartDocker">{{ restarting ? '重启中…' : '重启 Docker' }}</button>
          <button class="btn" :disabled="updating || (updateTask && updateTask.status==='running')" v-if="$root.user && $root.user.isAdmin" @click="updateEngine">{{ (updateTask && updateTask.status==='running') ? '更新中…' : '更新 Docker 引擎' }}</button>
          <button class="btn" :disabled="diagLoading" @click="runDiagnose">{{ diagLoading ? '诊断中…' : '连接诊断' }}</button>
        </div>
        <p v-if="restartMsg" class="muted-sm" style="margin-top:8px">{{ restartMsg }}</p>

        <!-- Docker 引擎更新：实时进度（进度条 + 日志） -->
        <div v-if="updateTask && (updateTask.status==='running')" class="upd-progress">
          <div class="upd-bar"><div class="upd-bar-fill" :style="{ width: ((updateTask.progress)||0) + '%' }"></div></div>
          <div class="upd-pct" v-if="updateTask.progress != null">进度 {{ updateTask.progress }}%</div>
          <div class="upd-log" v-if="updateTask.log && updateTask.log.length">
            <div v-for="(l,i) in updateTask.log" :key="i" class="upd-line">{{ l.msg }}</div>
          </div>
        </div>
        <p v-if="updateMsg" class="muted-sm" style="margin-top:8px">{{ updateMsg }}</p>

        <!-- 连接诊断结论（手动点"连接诊断"时展示） -->
        <div v-if="diag" class="diag-box" :class="diagStatusClass()" style="margin-top:10px">
          <div class="diag-status" :class="diagStatusClass()">{{ diagStatusText() }}</div>
          <ul class="diag-steps">
            <li v-for="(s,i) in diag.steps" :key="i" class="diag-step" :class="s.ok ? 'ok' : 'bad'">
              <span class="diag-ico">{{ s.ok ? '✓' : '✗' }}</span>
              <span class="diag-name">{{ s.name }}</span>
              <span class="diag-detail">{{ s.detail }}</span>
            </li>
          </ul>
          <div v-if="diag.hints && diag.hints.length" class="diag-hints">
            <div class="diag-hint-title">排查建议：</div>
            <div v-for="(h,i) in diag.hints" :key="i" class="diag-hint">· {{ h }}</div>
          </div>
        </div>
        <div v-if="diagErr" class="muted-sm" style="margin-top:8px">诊断失败：{{ diagErr }}</div>
      </div>

    </template>
  </div>`,
};

// ---------------------------------------------------------------- Containers
export const ContainersView = {
  data() {
    return {
      list: [], loading: false,
      showCreate: false,
      form: { image: '', name: '', ports: '', volumes: '', restart: 'no', cmd: '', autoRemove: false, labels: '' },
      q: '', stateFilter: 'all', stats: {}, rawPrev: {}, rawCur: {}, raw: {}, rowMenuId: null, menuC: null, menuPos: { top: 0, left: 0 }, page: 1, pageSize: 20, timer: null,
      colWidths: { name: '12%', image: '11%', status: '6%', update: '7%', cpu: '8%', mem: '11%', ip: '11%', ports: '11%', created: '9%' },
      resizingKey: null,
      // 容器详情抽屉
      showDetail: false, detail: null, detailId: null, detailLoading: false, detailTab: 'overview',
      selectedId: null, selectedName: '', selectedStats: null, selectedLogsText: '', selectedLogsLoading: false, selectedTimer: null, selectedLogTimer: null, monitorCollapsed: true,      shellCmd: '', shellLines: [], shellRunning: false, detailBusy: false, updating: false,
      rebuildSourceId: null, rebuildMenuId: null,
      // P0: 容器多选 + 重命名
      selIds: [], showRename: false, renameId: '', renameName: '', renameErr: '',
      // P1/P2: 排序 + 资源趋势 + 配置编辑
      sortKey: '', sortDir: 'desc', hist: {},
      showConfig: false, configId: '', configName: '', configuring: false, configErr: '',
      configForm: { restart: 'no', autoRemove: false, cmd: '', env: '', labels: '' },
      showRuntime: false, showCommit: false, runtimeSaving: false, commitSaving: false,
      runtimeForm: { memoryMb: '', cpuCores: '', cpuset: '', restart: 'no', maxRetry: 0 },
      commitForm: { repo: '', tag: 'latest', message: '', author: '' },
      // 镜像更新检测结果（由后端定时 / 手动检测写入），用于容器行标记"可更新"
      updateInfo: { checkedAt: 0, byRef: {} },
      checkingUpdates: false,
    };
  },
  computed: {
    filtered() {
      const q = (this.q || '').trim().toLowerCase();
      const f = this.stateFilter;
      return (this.list || []).filter((c) => {
        if (f !== 'all' && stateBadge(c.state) !== f) return false;
        if (!q) return true;
        const n = (c.names && c.names[0]) || '';
        return (n + ' ' + (c.image || '')).toLowerCase().indexOf(q) >= 0;
      });
    },
    sortRows() {
      const k = this.sortKey;
      if (!k) return this.filtered;
      const dir = this.sortDir === 'asc' ? 1 : -1;
      const arr = this.filtered.slice();
      arr.sort((a, b) => {
        let va, vb;
        if (k === 'name') { va = (a.names && a.names[0]) || ''; vb = (b.names && b.names[0]) || ''; }
        else if (k === 'image') { va = a.image || ''; vb = b.image || ''; }
        else if (k === 'status') { va = stateBadge(a.state); vb = stateBadge(b.state); }
        else if (k === 'cpu') { va = this.cpuPctNum(a.id) || 0; vb = this.cpuPctNum(b.id) || 0; }
        else if (k === 'mem') { va = (this.stats[a.id] && this.stats[a.id].memUsage) || 0; vb = (this.stats[b.id] && this.stats[b.id].memUsage) || 0; }
        else if (k === 'created') { va = a.created || 0; vb = b.created || 0; }
        else if (k === 'update') { va = this.hasUpdate(a) ? 1 : 0; vb = this.hasUpdate(b) ? 1 : 0; }
        else { va = ''; vb = ''; }
        if (va < vb) return -1 * dir; if (va > vb) return 1 * dir; return 0;
      });
      return arr;
    },
    totalPages() { return Math.max(1, Math.ceil(this.sortRows.length / this.pageSize)); },
    paged() {
      const s = (this.page - 1) * this.pageSize;
      return this.sortRows.slice(s, s + this.pageSize);
    },
    counts() {
      const r = { total: (this.list || []).length, running: 0, paused: 0, stopped: 0 };
      for (const c of this.list || []) {
        const b = stateBadge(c.state);
        if (b === 'running') r.running++;
        else if (b === 'paused') r.paused++;
        else r.stopped++;
      }
      return r;
    },
    allSel() {
      const p = this.paged || [];
      return p.length > 0 && p.every((c) => this.selIds.includes(c.id));
    },
    monStats() {
      if (!this.selectedId) return null;
      const s = this.stats[this.selectedId] || this.selectedStats;
      if (!s || s.error) return null;
      return {
        cpuPct: this.cpuPctNum(this.selectedId),
        memUsage: s.memUsage != null ? s.memUsage : null,
        memLimit: s.memLimit != null ? s.memLimit : null,
        memPct: this.memPct(this.selectedId),
      };
    },
  },
  mounted() {
    this.load();
    try { const s = JSON.parse(localStorage.getItem('wslmgr.colwidths') || 'null'); if (s) { let ok = true; for (const k in s) { if (typeof s[k] !== 'string' || !s[k].endsWith('%')) { ok = false; break; } } if (ok) Object.assign(this.colWidths, s); } } catch (e) {}
    this.timer = setInterval(this.pollStats, 5000);
  },
  unmounted() { if (this.timer) clearInterval(this.timer); if (this.selectedTimer) clearInterval(this.selectedTimer); },
  methods: {
    async load() {
      this.loading = true;
      try {
        this.list = await api.listContainers();
        if (this.page > this.totalPages) this.page = this.totalPages;
      } catch (e) { toast(e.message, 'err'); }
      finally { this.loading = false; }
      this.pollStats();
      // 拉取镜像更新检测结果，用于标记"可更新"徽标
      try { this.updateInfo = await api.getImageUpdates(); } catch (_) {}
    },
    sortBy(key) { if (this.sortKey === key) { this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc'; } else { this.sortKey = key; this.sortDir = 'asc'; } },
    healthOf(c) { try { const h = c.State && c.State.Health; return h && h.Status ? h.Status : ''; } catch (e) { return ''; } },
    healthText(c) { const h = this.healthOf(c); return h || '—'; },
    healthClass(c) { const h = this.healthOf(c); if (h === 'healthy') return 'ok'; if (h === 'unhealthy') return 'bad'; if (h === 'starting') return 'warn'; return 'none'; },
    usageSeries(id) { return (this.hist[id] || []).slice(-30); },
    sparkPoints(id, kind) {
      const arr = this.usageSeries(id);
      if (arr.length < 2) return '';
      return arr.map((p, i) => { const x = (i / (arr.length - 1)) * 200; const y = 40 - Math.max(0, Math.min(100, kind === 'cpu' ? p.cpu : p.mem)) / 100 * 40; return x.toFixed(1) + ',' + y.toFixed(1); }).join(' ');
    },
    async openConfig(c) {
      const id = c.id || c.Id || '';
      this.configId = id;
      this.configName = (c.names && c.names[0]) || (c.Name ? c.Name.replace(/^\//, '') : (c.shortId || (id || '').slice(0, 12)));
      this.configuring = false; this.configErr = '';
      try {
        const ins = await api.inspectContainer(this.configId);
        const cfg = (ins && ins.Config) || {};
        const host = (ins && ins.HostConfig) || {};
        this.configForm = {
          restart: host.RestartPolicy && host.RestartPolicy.Name ? host.RestartPolicy.Name : 'no',
          autoRemove: !!host.AutoRemove,
          cmd: (cfg.Cmd || []).join(' '),
          env: (cfg.Env || []).join('\n'),
          labels: Object.keys(cfg.Labels || {}).map((k) => k + '=' + cfg.Labels[k]).join('\n'),
        };
        this.showConfig = true;
      } catch (e) { toast('读取容器配置失败：' + e.message, 'err'); }
    },
    closeConfig() { this.showConfig = false; this.configId = ''; },
    openTerminal(c) { const id = c.id || c.Id || ''; if (this.$root && this.$root.nav) this.$root.nav('term/' + id); else location.hash = '#/term/' + id; },
    async doConfig() {
      const f = this.configForm;
      const body = {
        restart: f.restart,
        autoRemove: f.autoRemove,
        cmd: f.cmd.split(/\s+/).filter(Boolean),
        env: f.env.split('\n').map((x) => x.trim()).filter(Boolean),
        labels: f.labels.split('\n').map((x) => x.trim()).filter(Boolean).reduce((o, x) => { const i = x.indexOf('='); if (i >= 0) o[x.slice(0, i)] = x.slice(i + 1); return o; }, {}),
      };
      this.configuring = true; this.configErr = '';
      try { const r = await api.configureContainer(this.configId, body); toast('配置已更新，正在重建容器…', 'ok'); this.closeConfig(); if (r && r.taskId) whenTaskDone(r.taskId, async () => { await this.load(); if (this.showDetail) this.detail = await api.inspectContainer(this.detailId).catch(() => this.detail); }); }
      catch (e) { this.configErr = e.message; }
      finally { this.configuring = false; }
    },
    // ---- 每秒级刷新一次的 CPU / 内存（仅运行中的容器） ----
    async pollStats() {
      const ids = (this.list || []).filter((c) => stateBadge(c.state) === 'running').map((c) => c.id);
      if (!ids.length) { this.stats = {}; this.raw = {}; return; }
      try {
        const r = await api.containerStatsAll(ids);
        this.applyStats((r && r.stats) || {});
      } catch (_) { /* stats 不可用时保持上一次的数值 */ }
    },
    // 合并后端返回的 stats，保存原始 CPU 计数器用于跨轮次计算真实利用率
    applyStats(map) {
      const statsCopy = Object.assign({}, this.stats);
      const rawCopy = Object.assign({}, this.rawCur || {});
      let changed = false;
      for (const id in map) {
        const s = map[id];
        if (s && !s.error) {
          statsCopy[id] = s;
          const harr = (this.hist[id] || []).concat([{ cpu: this.cpuPctNum(id), mem: (s.memPct != null ? s.memPct : 0) }]);
          if (harr.length > 30) harr.shift();
          this.hist[id] = harr;
          changed = true;
          if (s.cpu) rawCopy[id] = { cur: s.cpu, ts: Date.now() };
        }
      }
      if (changed) {
        this.rawPrev = this.rawCur || {};
        this.rawCur = rawCopy;
        this.raw = rawCopy;
        this.stats = statsCopy;
      }
    },
    // 用相邻两次采集的原始 CPU 计数器算出真实利用率；缺数据时回退到后端 cpuPct
    cpuPctNum(id) {
      const cur = this.rawCur && this.rawCur[id];
      const prev = this.rawPrev && this.rawPrev[id];
      if (cur && prev && cur.cur && prev.cur) {
        const cpuD = (cur.cur.totalUsage || 0) - (prev.cur.totalUsage || 0);
        const sysD = (cur.cur.systemUsage || 0) - (prev.cur.systemUsage || 0);
        if (sysD > 0 && cpuD >= 0) {
          // 主机相对利用率：cpuDelta / hostDelta（已含全部核心），0–100%，
          // 比 Docker 默认「每核百分比」更直观（100% = 占满整台机器，而非 1 个核）。
          const pct = (cpuD / sysD) * 100;
          return Math.max(0, Math.min(100, pct));
        }
      }
      const s = this.statOf(id);
      if (s && typeof s.cpuPct === 'number') return Math.max(0, Math.min(100, s.cpuPct));
      return 0;
    },
    // 操作菜单已移至容器详情页（detail-actions 按钮栏）

    // ---- 拖拽调整列宽（鼠标 + 触摸），结束后写入 localStorage ----
    startResize(key, e) {
      const handle = e.currentTarget;
      const th = handle.closest('th');
      const table = th.closest('table');
      const tableW = table.getBoundingClientRect().width || 1;
      const startWpx = th.getBoundingClientRect().width;
      const px = e.touches ? e.touches[0].clientX : e.clientX;
      const move = (ev) => {
        if (ev.touches && ev.cancelable) ev.preventDefault();
        const cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
        let wpx = startWpx + (cx - px);
        if (wpx < 36) wpx = 36;
        this.colWidths[key] = (wpx / tableW * 100).toFixed(2) + '%';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.removeEventListener('touchmove', move);
        document.removeEventListener('touchend', up);
        document.body.classList.remove('col-resizing');
        this.resizingKey = null;
        try { localStorage.setItem('wslmgr.colwidths', JSON.stringify(this.colWidths)); } catch (e2) {}
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      document.addEventListener('touchmove', move, { passive: false });
      document.addEventListener('touchend', up);
      document.body.classList.add('col-resizing');
      this.resizingKey = key;
    },
    statOf(id) {
      const s = this.stats[id];
      if (!s || s.error) return null;
      return s;
    },
    cpuText(id) {
      const s = this.statOf(id);
      if (!s) return '-';
      const n = this.cpuPctNum(id);
      return (n > 0 || s.cpuPct != null) ? n.toFixed(2) + '%' : '-';
    },
    memText(id) {
      const s = this.statOf(id);
      if (!s || s.memUsage == null) return '-';
      return fmtBytes(s.memUsage);
    },
    memPct(id) {
      const s = this.statOf(id);
      if (!s || s.memPct == null) return 0;
      return Math.max(0, Math.min(100, s.memPct));
    },
    stateOf(c) { return stateBadge(c.state); },
    stateText(c) {
      const b = this.stateOf(c);
      if (b === 'running') return '已启动';
      if (b === 'paused') return '已暂停';
      if (b === 'exited') return '已停止';
      return c.state || '未知';
    },
    nameOf(c) { return (c.names && c.names[0]) || c.shortId; },
    when(sec) {
      if (!sec) return '-';
      const d = new Date(sec * 1000);
      const p = (n) => (n < 10 ? '0' + n : '' + n);
      return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    },
    portList(c) {
      const seen = {};
      const arr = [];
      for (const p of c.ports || []) {
        const proto = String(p.Type || 'tcp');
        const txt = p.PublicPort ? (p.PublicPort + ':' + p.PrivatePort + ' ' + proto.toUpperCase()) : (p.PrivatePort + '/' + proto);
        if (!seen[txt]) { seen[txt] = 1; arr.push(txt); }
      }
      return arr;
    },
    // 端口可点击：为每个端口生成「宿主机可访问的完整链接」
    portTargets(c) {
      const ip = c.ip || '';
      const out = [];
      for (const p of (c.ports || [])) {
        const proto = String(p.Type || 'tcp').toLowerCase();
        const hostIp = p.IP || '';
        const pub = p.PublicPort, priv = p.PrivatePort;
        if (pub) {
          // 已映射到宿主机：用 localhost 访问（WSL2 已做端口转发），绑定到具体 IP 时则用该 IP
          const host = (hostIp && hostIp !== '0.0.0.0' && hostIp !== '::') ? hostIp : 'localhost';
          out.push({ label: pub + ':' + priv + ' ' + proto.toUpperCase(), url: 'http://' + host + ':' + pub });
        } else if (priv) {
          // 仅容器内部端口：用容器 IP 作为参考链接
          out.push({ label: priv + '/' + proto, url: 'http://' + (ip || 'localhost') + ':' + priv });
        }
      }
      return out;
    },
    copyPortUrl(c, i) {
      const t = this.portTargets(c)[i];
      if (t) this.copyText(t.url);
    },
    onPortSelect(c, e) {
      const i = e.target.value;
      if (i === '' || i == null) return;
      this.copyPortUrl(c, +i);
      e.target.value = '';
    },
    copyText(txt) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(txt).then(() => toast('已复制：' + txt, 'ok'), () => this.fallbackCopy(txt));
        } else { this.fallbackCopy(txt); }
      } catch (_) { this.fallbackCopy(txt); }
    },
    fallbackCopy(txt) {
      try {
        const ta = document.createElement('textarea');
        ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0'; ta.style.top = '0'; ta.style.left = '0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        toast(ok ? ('已复制：' + txt) : ('复制失败：' + txt), ok ? 'ok' : 'err');
      } catch (_) { toast('复制失败：' + txt, 'err'); }
    },
    labelCount(c) { return Object.keys(c.labels || {}).length; },
    openRowMenu(c, e) {
      this.menuC = c;
      this.rowMenuId = this.rowMenuId === c.id ? null : c.id;
      if (this.rowMenuId) {
        const r = e.currentTarget.getBoundingClientRect();
        this.menuPos = { top: Math.round(r.bottom + 4), left: Math.max(8, Math.round(r.right - 180)) };
      }
    },
    menuStyle() {
      return { position: 'fixed', top: this.menuPos.top + 'px', left: this.menuPos.left + 'px' };
    },
    async rowRemove(c) {
      if (!confirmDanger('删除容器 ' + (c.name || c.Names || c.id) + '？此操作不可恢复，容器及其可写层数据将丢失。')) return;
      try { const r = await api.removeContainer(c.id, { force: true }); toast('删除任务已提交', 'ok'); if (r && r.taskId) whenTaskDone(r.taskId, () => this.load()); else this.load(); }
      catch (e) { toast('删除失败：' + e.message, 'err'); }
    },
    async rowRecreate(c) {
      if (!confirmDanger('重构（重建）容器 ' + (c.name || c.Names || c.id) + '？将按原配置删除并重新创建（不拉取新镜像），当前容器会短暂中断。')) return;
      try { const r = await api.containerRecreate(c.id); toast('重构任务已提交', 'ok'); if (r && r.taskId) whenTaskDone(r.taskId, () => this.load()); else this.load(); }
      catch (e) { toast('重构失败：' + e.message, 'err'); }
    },
    async doAction(id, act) {
      try { const r = await api.containerAction(id, act); toast('操作已在后台执行', 'ok'); whenTaskDone(r.taskId, () => this.load()); }
      catch (e) { toast(e.message, 'err'); }
    },
    async remove(id, name) {
      if (!confirmDanger('确认删除容器 ' + name + '？此操作不可恢复。')) return;
      try { const r = await api.removeContainer(id, { force: true, v: true }); toast('删除任务已创建', 'ok'); whenTaskDone(r.taskId, () => this.load()); }
      catch (e) { toast(e.message, 'err'); }
    },
    openCreate() { this.showCreate = true; this.form = { image: '', name: '', ports: '', volumes: '', restart: 'no', cmd: '', autoRemove: false }; },
    closeCreate() { this.showCreate = false; },
    parseLines(s) { return (s || '').split('\n').map(x => x.trim()).filter(Boolean); },
    async create() {
      const f = this.form;
      if (!f.image) { toast('请填写镜像', 'err'); return; }
      const cname = (f.name || '').trim();
      const bad = this.checkName(cname);
      if (bad) { toast(bad, 'err'); return; }
      const ports = this.parseLines(f.ports).map(l => {
        const p = l.split(':'); const proto = (p[2] || 'tcp').toLowerCase();
        return { host: p[0], container: p[1], proto };
      });
      const binds = this.parseLines(f.volumes).map(l => {
        const p = l.split(':'); return { win: p[0], container: p[1], mode: p[2] || 'rw' };
      });
      const labels = {};
      this.parseLines(f.labels).forEach(l => { const i = l.indexOf('='); if (i > 0) labels[l.slice(0, i)] = l.slice(i + 1); });
      const spec = {
        image: f.image, name: cname || undefined,
        cmd: f.cmd ? f.cmd.split(/\s+/) : undefined,
        labels,
        ports, binds, restartPolicy: f.restart, networkMode: 'bridge',
        autoRemove: f.autoRemove, privileged: false,
      };
      try { const r = await api.createContainer(spec); toast('创建任务已创建', 'ok'); this.closeCreate(); whenTaskDone(r.taskId, () => this.load()); }
      catch (e) { toast(e.message, 'err'); }
    },
    // 与后端一致的前置校验，避免把明显不合法的名字发给 Docker
    checkName(name) {
      if (!name) return '';
      if (name.length < 2) return '容器名「' + name + '」太短：Docker 要求至少 2 个字符，例如 ' + name + '01';
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) return '容器名只能包含字母、数字、下划线、点、连字符，且必须以字母或数字开头';
      return '';
    },
    // ---- 容器详情（点击名称打开抽屉） ----
    detailName() { return ((this.detail && this.detail.Name) || '').replace(/^\//, '') || (this.detailId || '').slice(0, 12); },
    async openDetail(c) {
      this.detailId = c.id; this.showDetail = true; this.detail = null; this.detailTab = 'overview';
      this.shellLines = []; this.shellCmd = '';
      this.detailLoading = true;
      try { this.detail = await api.inspectContainer(this.detailId); }
      catch (e) { toast(e.message, 'err'); }
      finally { this.detailLoading = false; }
      this.selectContainer(c);
    },
    closeDetail() {
      this.showDetail = false; this.detail = null; this.detailId = null;
    },
    setDetailTab(t) {
      this.detailTab = t;
      if (t === 'config') this.loadConfigForm();
      else if (t === 'runtime') this.loadRuntimeForm();
      else if (t === 'commit') this.openCommit();
    },
    // ---- 选中容器：在列表窗口下方统一展示「资源占用 + 日志」 ----
    selectContainer(c) {
      this.selectedId = c.id;
      this.selectedName = this.nameOf(c);
      this.selectedStats = null;
      this.selectedLogsText = '';
      this.loadSelectedLogs(true);
      this.refreshSelectedStats();
      if (this.selectedTimer) clearInterval(this.selectedTimer);
      this.selectedTimer = setInterval(() => { if (this.selectedId) this.refreshSelectedStats(); }, 3000);
      if (this.selectedLogTimer) clearInterval(this.selectedLogTimer);
      this.selectedLogTimer = setInterval(() => { if (this.selectedId) this.loadSelectedLogs(false); }, 4000);
    },
    async refreshSelectedStats() {
      if (!this.selectedId) return;
      try {
        const r = await api.containerStatsAll([this.selectedId]);
        const map = (r && r.stats) || {};
        this.applyStats(map);
        this.selectedStats = map[this.selectedId] || null;
      }
      catch (_) {}
    },
    async loadSelectedLogs(reset) {
      if (!this.selectedId) return;
      this.selectedLogsLoading = true;
      if (reset) this.selectedLogsText = '';
      try { this.selectedLogsText = await api.containerLogs(this.selectedId, { tail: 500, timestamps: true }); }
      catch (e) { this.selectedLogsText = '加载失败: ' + e.message; }
      finally {
        this.selectedLogsLoading = false;
        this.$nextTick(() => { const w = this.$refs.bpLogs; if (w) w.scrollTop = w.scrollHeight; });
      }
    },
    closeSelected() {
      this.selectedId = null; this.selectedName = ''; this.selectedStats = null; this.selectedLogsText = '';
      if (this.selectedTimer) { clearInterval(this.selectedTimer); this.selectedTimer = null; }
      if (this.selectedLogTimer) { clearInterval(this.selectedLogTimer); this.selectedLogTimer = null; }
    },
    // ---- 容器多选 + 批量操作 ----
    isSel(id) { return this.selIds.includes(id); },
    toggleSel(id) {
      const i = this.selIds.indexOf(id);
      if (i >= 0) this.selIds.splice(i, 1); else this.selIds.push(id);
    },
    toggleAllSel() {
      const p = this.paged || [];
      if (this.allSel) { this.selIds = this.selIds.filter((id) => !p.find((c) => c.id === id)); }
      else { for (const c of p) if (!this.selIds.includes(c.id)) this.selIds.push(c.id); }
    },
    clearSel() { this.selIds = []; },
    async batchAction(act) {
      if (!this.selIds.length) return;
      const ids = this.selIds.slice();
      const label = act === 'start' ? '启动' : act === 'stop' ? '停止' : act === 'restart' ? '重启' : act === 'update' ? '更新镜像' : '删除';
      if (!confirmDanger('确认对选中的 ' + ids.length + ' 个容器执行「' + label + '」？' + (act === 'update' ? '（将逐个拉取新镜像并按原配置重建容器）' : ''))) return;
      try { const r = await api.batchContainers(ids, act); toast('批量任务已创建', 'ok'); whenTaskDone(r.taskId, async () => { await this.load(); if (act === 'update') this.updateInfo = await api.getImageUpdates().catch(() => this.updateInfo); }); }
      catch (e) { toast(e.message, 'err'); }
    },
    async batchRestart() { await this.batchAction('restart'); },
    async batchUpdate() { await this.batchAction('update'); },
    // 触发后端镜像更新检测（后台任务），完成后刷新徽标
    async checkUpdates() {
      if (this.checkingUpdates) return;
      this.checkingUpdates = true;
      try {
        const r = await api.checkImageUpdates();
        toast('正在后台检测镜像更新…', 'ok');
        whenTaskDone(r.taskId, async () => {
          this.updateInfo = await api.getImageUpdates().catch(() => this.updateInfo);
          this.load();
        });
      } catch (e) { toast(e.message, 'err'); }
      finally { this.checkingUpdates = false; }
    },
    async batchRemove() { await this.batchAction('remove'); },
    // 行内"更新"：拉取该容器镜像最新版本并按原配置重建（复用后端 update 流程）
    async rowUpdate(c) {
      if (!confirmDanger('更新镜像并重建容器 ' + this.nameOf(c) + '？将拉取该镜像的最新版本，并按原配置（端口/卷/环境变量/标签/重启策略/网络）重建容器。当前容器会被删除后重建。')) return;
      try {
        const r = await api.updateContainerImage(c.id);
        toast('已提交更新任务，详见右下角后台任务', 'ok');
        whenTaskDone(r.taskId, async () => { await this.load(); this.updateInfo = await api.getImageUpdates().catch(() => this.updateInfo); });
      } catch (e) { toast(e.message, 'err'); }
    },
    // 该容器镜像是否存在可更新版本（依据后端检测结果）
    hasUpdate(c) {
      const info = this.updateInfo && this.updateInfo.byRef;
      if (!info || !c.image) return false;
      if (info[c.image] && info[c.image].hasUpdate) return true;
      // 容器可能以无 tag 形式引用镜像（如 nginx），规范化为 repo:latest 再查一次
      if (c.image.indexOf('@') < 0 && !/:[^/]+$/.test(c.image)) {
        const norm = c.image + ':latest';
        if (info[norm] && info[norm].hasUpdate) return true;
      }
      return false;
    },
    async pruneStopped() {
      if (!confirmDanger('确认删除所有已停止的容器？此操作不可恢复，正在运行的容器不受影响。')) return;
      try { const r = await api.pruneContainers(); toast('清理任务已创建', 'ok'); whenTaskDone(r.taskId, () => this.load()); }
      catch (e) { toast(e.message, 'err'); }
    },
    // ---- 重命名 ----
    openRename(c) { this.renameId = c.id; this.renameName = this.nameOf(c); this.renameErr = ''; this.showRename = true; },
    closeRename() { this.showRename = false; this.renameId = ''; },
    async doRename() {
      const name = (this.renameName || '').trim();
      const bad = this.checkName(name);
      if (bad) { this.renameErr = bad; return; }
      try { const r = await api.renameContainer(this.renameId, name); toast('重命名任务已创建', 'ok'); this.closeRename(); whenTaskDone(r.taskId, () => this.load()); }
      catch (e) { this.renameErr = e.message; }
    },

    openFullLogs() {
      if (!this.selectedId) return;
      location.hash = '#/clogs/' + this.selectedId;
    },
    async execShell() {
      if (!this.shellCmd || !this.shellCmd.trim()) { toast('请输入要执行的命令', 'err'); return; }
      if (!this.detailId) return;
      this.shellRunning = true;
      const cmd = this.shellCmd;
      this.shellLines.push({ cmd });
      try {
        const r = await api.containerExec(this.detailId, cmd);
        this.shellLines.push({ out: (r && r.output) || '(无输出)' });
      } catch (e) { this.shellLines.push({ out: '执行失败: ' + e.message }); }
      finally {
        this.shellRunning = false;
        this.shellCmd = '';
        this.$nextTick(() => { const w = this.$refs.termWin; if (w) w.scrollTop = w.scrollHeight; });
      }
    },
    async updateImage() {
      if (!confirmDanger('更新镜像并重建容器？将拉取该镜像的最新版本，并按原配置（端口/卷/环境变量/标签/重启策略/网络）重建容器。当前容器会被删除后重建。')) return;
      this.updating = true;
      try {
        const r = await api.updateContainerImage(this.detailId);
        toast('已提交更新任务，详见右下角后台任务', 'ok');
        whenTaskDone(r.taskId, async (t) => {
          if (t && t.status === 'error') toast('更新失败：' + (t.error || '未知错误'), 'err');
          else toast('容器已用新镜像重建并启动', 'ok');
          if (this.showDetail) { this.detail = await api.inspectContainer(this.detailId).catch(() => this.detail); }
          this.load();
          this.updateInfo = await api.getImageUpdates().catch(() => this.updateInfo);
        });
      } catch (e) { toast(e.message, 'err'); }
      finally { this.updating = false; }
    },
    // 详情辅助：从 inspect 结果提取各字段
    dState() { return (this.detail && this.detail.State) || {}; },
    dIsRunning() { const s = (this.dState().Status || '').toLowerCase(); return s === 'running'; },
    dIsPaused() { const s = (this.dState().Status || '').toLowerCase(); return s === 'paused'; },
    // 生命周期操作：启动/停止/重启/暂停/恢复（走后台任务）
    async detailAction(action) {
      if (!this.detailId || this.detailBusy) return;
      const verb = { start: '启动', stop: '停止', restart: '重启', pause: '暂停', unpause: '恢复' }[action] || action;
      this.detailBusy = true;
      try {
        const r = await api.containerAction(this.detailId, action);
        toast(verb + '任务已提交', 'ok');
        whenTaskDone(r.taskId, async () => {
          this.detail = await api.inspectContainer(this.detailId).catch(() => this.detail);
          this.refreshSelectedStats();
          this.load();
        });
      } catch (e) { toast(e.message, 'err'); }
      finally { this.detailBusy = false; }
    },
    async detailRemove() {
      if (!this.detailId) return;
      if (!confirmDanger('确认删除该容器？此操作不可恢复（必要时会强制删除）。')) return;
      try {
        const r = await api.removeContainer(this.detailId, { force: 1 });
        toast('删除任务已提交', 'ok');
        whenTaskDone(r.taskId, () => { this.closeDetail(); this.load(); });
      } catch (e) { toast(e.message, 'err'); }
    },
    async detailRecreate() {
      if (!this.detailId || this.detailBusy) return;
      if (!confirmDanger('重构（重建）容器？将按原配置删除并重新创建（不拉取新镜像），当前容器会短暂中断后重新启动。')) return;
      this.detailBusy = true;
      try {
        const r = await api.containerRecreate(this.detailId);
        toast('重构任务已提交', 'ok');
        whenTaskDone(r.taskId, async (t) => {
          if (t && t.status === 'error') toast('重构失败：' + (t.error || '未知错误'), 'err');
          else toast('容器已重构并启动', 'ok');
          this.detail = await api.inspectContainer(this.detailId).catch(() => this.detail);
          this.refreshSelectedStats();
          this.load();
        });
      } catch (e) { toast(e.message, 'err'); }
      finally { this.detailBusy = false; }
    },
    detailC() {
      if (!this.detail) return null;
      return {
        id: this.detailId,
        imageId: this.detail.Id,
        image: this.dConfig().Image,
        Name: this.detail.Name,
        names: this.detail.Names,
        shortId: (this.detailId || '').slice(0, 12),
      };
    },
    // 行内「使用此镜像重新设置」：用当前容器配置预填构建弹窗（用户可改设置后重建）
    async openRebuildSettings(c) {
      this.buildImg = { Id: c.imageId, RepoTags: [c.image] };
      this.rebuildSourceId = c.id;
      this.building = false;
      try {
        const insp = await api.inspectContainer(c.id);
        const cfg = insp.Config || {};
        const hc = insp.HostConfig || {};
        const name = (insp.Name || '').replace(/^\//, '');
        const pb = hc.PortBindings || {};
        const ports = Object.keys(pb).length ? Object.keys(pb).map((k) => {
          const parts = k.split('/');
          const container = parts[0];
          const proto = (parts[1] || 'tcp').toLowerCase();
          const b = (pb[k] || [])[0] || {};
          return { host: b.HostPort || container, container, proto: (proto || 'tcp').toLowerCase() };
        }) : [];
        const env = (cfg.Env || []).map((s) => { const i = s.indexOf('='); return { key: i >= 0 ? s.slice(0, i) : s, value: i >= 0 ? s.slice(i + 1) : '' }; });
        const vols = (insp.Mounts || []).filter((m) => m.Type === 'bind').map((m) => ({ win: m.Source || '', container: m.Destination || '', mode: (m.Mode || 'rw').split(',')[0] }));
        const fromBinds = (hc.Binds || []).filter((b) => !vols.some((v) => (v.win + ':' + v.container) === b)).map((b) => { const parts = b.split(':'); return { win: parts[0], container: parts[1], mode: parts[2] || 'rw' }; });
        const allVols = vols.concat(fromBinds);
        const labels = Object.keys(cfg.Labels || {}).map((k) => ({ key: k, value: cfg.Labels[k] }));
        this.form = {
          image: cfg.Image || c.image,
          name,
          ports: ports.length ? ports : [{ host: '', container: '', proto: 'tcp' }],
          volumes: allVols.length ? allVols : [{ win: '', container: '', mode: 'rw' }],
          env: env.length ? env : [{ key: '', value: '' }],
          labels: labels.length ? labels : [{ key: '', value: '' }],
          restart: (hc.RestartPolicy && hc.RestartPolicy.Name) || 'no',
          cmd: Array.isArray(cfg.Cmd) ? cfg.Cmd.join(' ') : (cfg.Cmd || ''),
          autoRemove: !!hc.AutoRemove,
        };
        this.showBuild = true;
      } catch (e) { toast('读取容器配置失败：' + e.message, 'err'); this.rebuildSourceId = null; }
    },
    // 行内「直接重新构建（沿用当前设置）」：不拉镜像，按原配置删了重建
    async rebuildDirect(c) {
      if (!confirmDanger('直接重新构建（沿用当前设置）？将按原配置删除并重新创建（不拉取新镜像），容器会短暂中断后重新启动。')) return;
      try {
        const r = await api.containerRecreate(c.id);
        toast('重构任务已提交', 'ok');
        whenTaskDone(r.taskId, () => this.load());
      } catch (e) { toast(e.message, 'err'); }
    },
    dConfig() { return (this.detail && this.detail.Config) || {}; },
    dHost() { return (this.detail && this.detail.HostConfig) || {}; },
    dNet() { return (this.detail && this.detail.NetworkSettings) || {}; },
    detailPorts() {
      const ns = this.dNet();
      const ports = ns.Ports || {};
      const out = [];
      for (const key of Object.keys(ports || {})) {
        for (const b of (ports[key] || [])) {
          out.push({ container: key, host: b.HostPort ? (b.HostIp + ':' + b.HostPort) : '（仅容器内部）' });
        }
      }
      if (!out.length) { const ep = this.dConfig().ExposedPorts || {}; for (const k of Object.keys(ep)) out.push({ container: k, host: '（仅容器内部）' }); }
      return out;
    },
    detailNetworks() {
      const ns = this.dNet();
      const nets = ns.Networks || {};
      return Object.keys(nets).map((name) => Object.assign({ name }, nets[name]));
    },
    detailMounts() {
      const ms = this.detail && this.detail.Mounts ? this.detail.Mounts : [];
      const binds = this.dHost().Binds || [];
      const fromBinds = binds.filter((b) => !ms.some((m) => (m.Source + ':' + m.Destination) === b)).map((b) => {
        const [s, d, mode] = b.split(':'); return { type: 'bind', source: s, dest: d, mode: mode || '' };
      });
      return ms.map((m) => ({ type: m.Type, source: m.Source, dest: m.Destination, mode: m.Mode || '' })).concat(fromBinds);
    },
    detailEnv() { return this.dConfig().Env || []; },
    detailLabels() { return this.dConfig().Labels || {}; },
    detailLabelList() { const l = this.dConfig().Labels || {}; return Object.keys(l).map((k) => ({ key: k, value: l[k] })); },
    detailLabelCount() { return Object.keys(this.detailLabels()).length; },
    async openRuntime(c) {
      const id = (c && typeof c === 'object') ? (c.id || c.Id || '') : c;
      if (!id) return;
      const f = { memoryMb: '', cpuCores: '', cpuset: '', restart: 'no', maxRetry: 0 };
      try {
        const insp = await api.inspectContainer(id);
        const hc = insp && insp.HostConfig;
        if (hc) {
          if (hc.Memory) f.memoryMb = Math.round(hc.Memory / (1024 * 1024));
          if (hc.CpuQuota && hc.CpuPeriod) f.cpuCores = (hc.CpuQuota / hc.CpuPeriod).toString();
          if (hc.CpuSetCpus) f.cpuset = hc.CpuSetCpus;
          if (hc.RestartPolicy && hc.RestartPolicy.Name) f.restart = hc.RestartPolicy.Name;
        }
      } catch (e) { toast('读取容器配置失败：' + e.message, 'err'); return; }
      this.runtimeForm = f;
    },
    openCommit() { this.commitForm = { repo: '', tag: 'latest', message: '', author: '' }; },
    async loadConfigForm() {
      const c = this.detailC();
      const id = (c && typeof c === 'object') ? (c.id || c.Id || '') : c;
      this.configId = id;
      this.configName = (c && ((c.names && c.names[0]) || (c.Name ? c.Name.replace(/^\//, '') : (c.shortId || (id || '').slice(0, 12))))) || '';
      this.configuring = false; this.configErr = '';
      try {
        const ins = await api.inspectContainer(this.configId);
        const cfg = (ins && ins.Config) || {};
        const host = (ins && ins.HostConfig) || {};
        this.configForm = {
          restart: host.RestartPolicy && host.RestartPolicy.Name ? host.RestartPolicy.Name : 'no',
          autoRemove: !!host.AutoRemove,
          cmd: (cfg.Cmd || []).join(' '),
          env: (cfg.Env || []).join('\n'),
          labels: Object.keys(cfg.Labels || {}).map((k) => k + '=' + cfg.Labels[k]).join('\n'),
        };
      } catch (e) { toast('读取容器配置失败：' + e.message, 'err'); }
    },
    async loadRuntimeForm() {
      const c = this.detailC();
      const id = (c && typeof c === 'object') ? (c.id || c.Id || '') : c;
      if (!id) return;
      const f = { memoryMb: '', cpuCores: '', cpuset: '', restart: 'no', maxRetry: 0 };
      try {
        const insp = await api.inspectContainer(id);
        const hc = insp && insp.HostConfig;
        if (hc) {
          if (hc.Memory) f.memoryMb = Math.round(hc.Memory / (1024 * 1024));
          if (hc.CpuQuota && hc.CpuPeriod) f.cpuCores = (hc.CpuQuota / hc.CpuPeriod).toString();
          if (hc.CpuSetCpus) f.cpuset = hc.CpuSetCpus;
          if (hc.RestartPolicy && hc.RestartPolicy.Name) f.restart = hc.RestartPolicy.Name;
        }
      } catch (e) { toast('读取容器配置失败：' + e.message, 'err'); return; }
      this.runtimeForm = f;
    },
    async applyRuntime() {
      const id = this.detailId;
      if (!id) return;
      const f = this.runtimeForm;
      const body = { restartPolicy: f.restart, maximumRetryCount: f.maxRetry };
      if (f.memoryMb) body.memory = Number(f.memoryMb) * 1024 * 1024;
      if (f.cpuCores) { body.cpuQuota = Math.round(Number(f.cpuCores) * 100000); body.cpuPeriod = 100000; }
      if (f.cpuset) body.cpusetCpus = f.cpuset;
      this.runtimeSaving = true;
      try { const r = await api.updateContainerConfig(id, body); toast('运行时配置已更新', 'ok'); this.setDetailTab('overview'); whenTaskDone(r.taskId, async () => { await this.load(); if (this.showDetail) this.detail = await api.inspectContainer(this.detailId).catch(() => this.detail); }); }
      catch (e) { toast(e.message, 'err'); }
      finally { this.runtimeSaving = false; }
    },
    async applyCommit() {
      const id = this.detailId;
      if (!id) return;
      this.commitSaving = true;
      try { const r = await api.commitContainer(id, this.commitForm); toast('已提交为镜像 ' + (r.ref || r.id), 'ok'); whenTaskDone(r.taskId, () => this.load()); this.setDetailTab('overview'); }
      catch (e) { toast(e.message, 'err'); }
      finally { this.commitSaving = false; }
    },
  },
  template: `
  <div class="view">
    <div class="page-head">
      <div>
        <h2 class="page-title" style="margin:0">容器</h2>
        <p class="page-sub" style="margin:2px 0 0">管理 WSL 内的 Docker 容器</p>
        <div class="head-chips">
          <span class="chip">共 <b>{{ counts.total }}</b> 个</span>
          <span class="chip ok"><i class="dot"></i>运行中 <b>{{ counts.running }}</b></span>
          <span class="chip warn" v-if="counts.paused"><i class="dot"></i>暂停 <b>{{ counts.paused }}</b></span>
          <span class="chip gray"><i class="dot"></i>已停止 <b>{{ counts.stopped }}</b></span>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn primary" @click="openCreate">+ 新建容器</button>
        <button class="btn" @click="load">刷新</button>
        <button class="btn" @click="pruneStopped" title="删除所有已停止的容器，释放空间">清理已停止</button>
      </div>
    </div>

    <div class="toolbar">
      <div class="filter-bar">
        <input class="search" v-model="q" placeholder="搜索容器名或镜像…">
        <select class="sel-sm" v-model="stateFilter">
          <option value="all">全部状态</option>
          <option value="running">运行中</option>
          <option value="paused">已暂停</option>
          <option value="exited">已停止</option>
        </select>
        <button class="btn sm" @click="load">刷新列表</button>
        <button class="btn sm" :disabled="checkingUpdates" @click="checkUpdates" title="逐个比对本地镜像与远端 registry 的 digest，标记可更新的容器">{{ checkingUpdates ? '检测中…' : '检查镜像更新' }}</button>
      </div>
      <div class="muted-sm">点击列表任意一行，即可在下方实时监控该容器的 CPU / 内存占用与日志</div>
    </div>

    <div v-if="selIds.length" class="batch-bar">
      <span class="batch-info">已选 <b>{{ selIds.length }}</b> 个容器</span>
      <button class="btn sm" @click="batchAction('start')">批量启动</button>
      <button class="btn sm" @click="batchAction('stop')">批量停止</button>
      <button class="btn sm" @click="batchRestart">批量重启</button>
      <button class="btn sm primary" @click="batchUpdate">批量更新</button>
      <button class="btn sm danger" @click="batchRemove">批量删除</button>
      <button class="btn sm" @click="clearSel">取消选择</button>
    </div>

    <div v-if="loading" class="center-pad"><span class="spinner"></span> 加载中…</div>
    <div v-else-if="!list.length" class="empty">没有容器。点击右上角「新建容器」。</div>
    <div v-else class="view-body">
        <div class="card tbl-wrap list-scroll">
      <table class="tbl modern">
        <thead>
          <tr>
            <th class="c-sel"><input type="checkbox" :checked="allSel" @change="toggleAllSel" title="全选当前页"></th>
            <th :style="{ width: colWidths.name }" class="sort-th" @click="sortBy('name')">名称<span class="sort-caret">{{ sortKey==='name' ? (sortDir==='asc'?'▲':'▼') : '' }}</span><span class="col-resizer" @mousedown.prevent.stop="startResize('name', $event)" @touchstart.prevent.stop="startResize('name', $event)"></span></th>
            <th :style="{ width: colWidths.image }" class="sort-th" @click="sortBy('image')">镜像<span class="sort-caret">{{ sortKey==='image' ? (sortDir==='asc'?'▲':'▼') : '' }}</span><span class="col-resizer" @mousedown.prevent.stop="startResize('image', $event)" @touchstart.prevent.stop="startResize('image', $event)"></span></th>
            <th :style="{ width: colWidths.status }" class="sort-th" @click="sortBy('status')">状态<span class="sort-caret">{{ sortKey==='status' ? (sortDir==='asc'?'▲':'▼') : '' }}</span><span class="col-resizer" @mousedown.prevent.stop="startResize('status', $event)" @touchstart.prevent.stop="startResize('status', $event)"></span></th>
            <th :style="{ width: colWidths.update }" class="sort-th" @click="sortBy('update')">更新<span class="sort-caret">{{ sortKey==='update' ? (sortDir==='asc'?'▲':'▼') : '' }}</span><span class="col-resizer" @mousedown.prevent.stop="startResize('update', $event)" @touchstart.prevent.stop="startResize('update', $event)"></span></th>
            <th :style="{ width: colWidths.cpu }" class="sort-th" @click="sortBy('cpu')">CPU 使用率<span class="sort-caret">{{ sortKey==='cpu' ? (sortDir==='asc'?'▲':'▼') : '' }}</span><span class="col-resizer" @mousedown.prevent.stop="startResize('cpu', $event)" @touchstart.prevent.stop="startResize('cpu', $event)"></span></th>
            <th :style="{ width: colWidths.mem }" class="sort-th" @click="sortBy('mem')">内存使用率<span class="sort-caret">{{ sortKey==='mem' ? (sortDir==='asc'?'▲':'▼') : '' }}</span><span class="col-resizer" @mousedown.prevent.stop="startResize('mem', $event)" @touchstart.prevent.stop="startResize('mem', $event)"></span></th>
            <th :style="{ width: colWidths.ip }">IP 地址<span class="col-resizer" @mousedown.prevent.stop="startResize('ip', $event)" @touchstart.prevent.stop="startResize('ip', $event)"></span></th>
            <th :style="{ width: colWidths.ports }">端口<span class="col-resizer" @mousedown.prevent.stop="startResize('ports', $event)" @touchstart.prevent.stop="startResize('ports', $event)"></span></th>
            <th :style="{ width: colWidths.created }" class="sort-th" @click="sortBy('created')">创建时间<span class="sort-caret">{{ sortKey==='created' ? (sortDir==='asc'?'▲':'▼') : '' }}</span><span class="col-resizer" @mousedown.prevent.stop="startResize('created', $event)" @touchstart.prevent.stop="startResize('created', $event)"></span></th>
            <th class="c-act">操作</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="c in paged" :key="c.id">
            <tr @click="selectContainer(c)">
              <td class="c-sel"><input type="checkbox" :checked="isSel(c.id)" @click.stop="toggleSel(c.id)"></td>
              <td>
                <div class="cell-main">
                  <span class="status-dot" :class="stateOf(c)"></span>
                  <div class="cell-text">
                    <div class="name link" @click.stop="openDetail(c)" title="点击查看容器详情（状态/日志/资源/端口/网络/存储/标签/终端/更新镜像）">{{ nameOf(c) }}</div>
                    <div class="sub mono">{{ c.shortId }}</div>
                  </div>
                </div>
              </td>
              <td class="mono"><div class="cell-wrap" :title="c.image">{{ c.image }}</div></td>
              <td>
                <span class="pill" :class="stateOf(c) === 'running' ? 'ok' : (stateOf(c) === 'paused' ? 'warn' : 'gray')">
                  <i class="dot"></i>{{ stateText(c) }}
                </span>
              </td>
              <td class="ctr">
                <template v-if="hasUpdate(c)">
                  <span class="upd-ico" title="检测到该镜像有新版可用，点击「更新」拉取并重建容器">
                    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M8 3L4.5 6.5M8 3l3.5 3.5"/></svg>
                  </span>
                  <button class="btn sm primary up-btn" @click.stop="rowUpdate(c)">更新</button>
                </template>
                <span v-else class="muted-sm">—</span>
              </td>
              <td class="num" :class="{ muted: cpuText(c.id) === '-' }" :title="cpuText(c.id) === '-' ? '仅运行中容器可采集' : ''">{{ cpuText(c.id) }}</td>
              <td class="num" :class="{ muted: memText(c.id) === '-' }" :title="memText(c.id) === '-' ? '仅运行中容器可采集' : ''">{{ memText(c.id) }}</td>
              <td class="mono" :title="c.ip || '无 IP'">{{ c.ip || '-' }}</td>
              <td>
                <div class="port-cell">
                  <template v-if="portTargets(c).length === 1">
                    <span class="port-pill link" :title="'点击复制 ' + portTargets(c)[0].url" @click.stop="copyPortUrl(c, 0)">{{ portTargets(c)[0].label }}</span>
                  </template>
                  <template v-else-if="portTargets(c).length > 1">
                    <select class="port-select" title="选择端口以复制完整链接" @change.stop="onPortSelect(c, $event)">
                      <option value="">端口链接 ▾</option>
                      <option v-for="(t, i) in portTargets(c)" :key="i" :value="i">{{ t.label }}</option>
                    </select>
                  </template>
                  <span v-else class="muted-sm">无端口</span>
                </div>
              </td>
              <td :title="when(c.created)">{{ when(c.created) }}</td>
              <td>
                <div class="dd">
                  <button class="dd-toggle" @click.stop="openRowMenu(c, $event)">操作 ▾</button>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
      <teleport to="body">
        <div v-if="rowMenuId" class="dd-backdrop" @click="rowMenuId = null"></div>
        <div v-if="rowMenuId && menuC" class="dd-menu" :style="menuStyle()">
          <div class="dd-item" :class="{ disabled: stateOf(menuC) === 'running' }" @click="doAction(menuC.id, 'start')">启动</div>
          <div class="dd-item" :class="{ disabled: stateOf(menuC) !== 'running' }" @click="doAction(menuC.id, 'stop')">停止</div>
          <div class="dd-item" v-if="stateOf(menuC) === 'running'" @click="doAction(menuC.id, 'pause')">暂停</div>
          <div class="dd-item" v-else-if="stateOf(menuC) === 'paused'" @click="doAction(menuC.id, 'unpause')">恢复</div>
          <div class="dd-item" :class="{ disabled: stateOf(menuC) !== 'running' }" @click="doAction(menuC.id, 'restart')">重启</div>
          <div class="dd-item danger" @click="rowRemove(menuC)">删除</div>
          <div class="dd-item" @click="rowRecreate(menuC)">重构</div>
          <div class="dd-item" @click="openRename(menuC)">重命名</div>
        </div>
      </teleport>
      </div><!-- /list-scroll -->
      <div class="pager">
        <span class="pg-count">共 <b>{{ filtered.length }}</b> 个 · 每页 {{ pageSize }} 行</span>
        <div class="pager-btns">
          <button class="btn sm pg-btn" :disabled="page <= 1" @click="page = page - 1"><span class="pg-chev">‹</span> 上一页</button>
          <span class="pg-ind">第 <b>{{ page }}</b> / {{ totalPages }} 页</span>
          <button class="btn sm pg-btn" :disabled="page >= totalPages" @click="page = page + 1">下一页 <span class="pg-chev">›</span></button>
        </div>
      </div>
    </div>

    <div class="bottom-panel" :class="{ collapsed: monitorCollapsed }">
      <div class="bp-head">
        <div class="bp-title">容器监控<template v-if="selectedName"> · <b>{{ selectedName }}</b> <span class="mono muted-sm">{{ selectedId.slice(0,12) }}</span></template></div>
        <div class="bp-actions">
          <button class="btn sm" @click="monitorCollapsed = !monitorCollapsed" :title="monitorCollapsed ? '展开实时监控面板（资源占用 + 日志）' : '收起监控面板，把空间还给列表'">{{ monitorCollapsed ? '展开监控 ▴' : '收起 ▾' }}</button>
          <button class="btn sm" :disabled="!selectedId || selectedLogsLoading" @click="loadSelectedLogs" v-show="!monitorCollapsed">刷新日志</button>
          <button class="btn sm share" :disabled="!selectedId" @click="openFullLogs" title="在新页面完整查看日志" v-show="!monitorCollapsed">
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5H3.5v9h9V10"/><path d="M9.5 3.5H13v3.5"/><path d="M13 3.5L7 9.5"/></svg>
            完整日志
          </button>
        </div>
      </div>
      <div class="bp-body">
        <div class="bp-res" v-if="monStats">
          <div class="res-grid">
            <div class="res-card">
              <div class="res-label">CPU 使用率</div>
              <div class="res-value">{{ (monStats.cpuPct != null) ? monStats.cpuPct.toFixed(2) + '%' : '—' }}</div>
              <div class="mini-bar wide"><span :style="{ width: ((monStats.cpuPct != null) ? Math.min(100, monStats.cpuPct) : 0) + '%' }"></span></div>
            </div>
            <div class="res-card">
              <div class="res-label">内存使用</div>
              <div class="res-value">{{ (monStats.memUsage != null) ? fmtBytes(monStats.memUsage) + ' / ' + fmtBytes(monStats.memLimit) : '—' }}</div>
              <div class="mini-bar wide"><span :style="{ width: ((monStats.memPct != null) ? monStats.memPct : 0) + '%', background: '#2fa66b' }"></span></div>
            </div>
          </div>
          <div class="res-chart" v-if="monStats && selectedId">
            <div class="chart-cap">资源趋势（最近 {{ usageSeries(selectedId).length }} 次采样）</div>
            <svg class="spark" viewBox="0 0 200 40" preserveAspectRatio="none">
              <polyline class="spark-cpu" :points="sparkPoints(selectedId, 'cpu')" fill="none" />
              <polyline class="spark-mem" :points="sparkPoints(selectedId, 'mem')" fill="none" />
            </svg>
            <div class="chart-legend"><span class="lg cpu">CPU</span><span class="lg mem">内存</span></div>
          </div>
          <p class="muted-sm" style="margin-top:8px">每 3 秒自动刷新（运行中容器）。</p>
        </div>
        <div class="bp-res panel-hint" v-else>
          <span class="hint-icon">▦</span>
          <span>未选择容器 — 点击列表中的任意一行，即可在此实时查看该容器的 CPU / 内存占用与日志。</span>
        </div>
        <div class="bp-logs" v-if="selectedId">
          <div v-if="selectedLogsLoading && !selectedLogsText" class="center-pad"><span class="spinner"></span></div>
          <pre v-else ref="bpLogs" class="code-box">{{ selectedLogsText || '(空)' }}</pre>
        </div>
        <div class="bp-logs panel-hint" v-else>（选择容器后显示其实时日志）</div>
      </div>
    </div>

    <div v-if="showRename" class="modal-mask" @click.self="closeRename">
      <div class="modal">
        <header>重命名容器 <span class="x" @click="closeRename">×</span></header>
        <div class="body">
          <div class="muted-sm" style="margin-top:0">当前名称：<b>{{ renameName }}</b></div>
          <label class="fld"><span>新名称（≥2 字符，字母/数字/下划线/点/连字符开头）</span><input v-model="renameName" placeholder="new-name"></label>
          <div v-if="renameErr" style="color:#e5484d;font-size:13px">{{ renameErr }}</div>
        </div>
        <footer><button class="btn" @click="closeRename">取消</button><button class="btn primary" :disabled="!renameName" @click="doRename">重命名</button></footer>
      </div>
    </div>

    <div v-if="showCreate" class="modal-mask" @click.self="closeCreate">
      <div class="modal">
        <header>新建容器 <span class="x" @click="closeCreate">×</span></header>
        <div class="body">
          <label class="fld"><span>镜像 (必填, 如 nginx:alpine)</span><input v-model="form.image" placeholder="nginx:alpine"></label>
          <label class="fld"><span>名称 (可选，留空由 Docker 自动命名；至少 2 个字符)</span><input v-model="form.name" placeholder="my-nginx"></label>
          <div class="row2">
            <label class="fld"><span>端口映射 (每行 host:container[:proto])</span>
              <textarea v-model="form.ports" rows="3" placeholder="8080:80&#10;8443:443:tcp"></textarea></label>
            <label class="fld"><span>卷绑定 (每行 Windows路径:容器路径[:rw|ro])</span>
              <textarea v-model="form.volumes" rows="3" placeholder="D:\\data:/app/data:rw"></textarea></label>
          </div>
          <div class="row2">
            <label class="fld"><span>重启策略</span>
              <select v-model="form.restart"><option value="no">不重启</option><option value="on-failure">失败时重启</option><option value="always">总是重启</option><option value="unless-stopped">除非手动停止</option></select></label>
            <label class="fld"><span>启动命令 (可选, 空格分隔)</span><input v-model="form.cmd" placeholder="如 nginx -g 'daemon off;'"></label>
          </div>
          <label class="fld"><span>元数据标签 (可选, 每行 KEY=VALUE)</span>
            <textarea v-model="form.labels" rows="2" placeholder="com.example.app=web&#10;version=1.0"></textarea></label>
          <label class="fld"><span><input type="checkbox" v-model="form.autoRemove" style="width:auto;margin-right:6px">退出后自动删除容器</span></label>
          <p class="page-sub" style="margin-top:4px">小贴士：卷绑定的 Windows 路径会自动转为 WSL 的 /mnt/d/... 格式。</p>
        </div>
        <footer>
          <button class="btn" @click="closeCreate">取消</button>
          <button class="btn primary" @click="create">创建并启动</button>
        </footer>
      </div>
    </div>

    <div v-if="showDetail" class="modal-mask" @click.self="closeDetail">
      <div class="modal wide">
        <header>容器详情 <span class="mono" style="font-weight:normal">{{ detailName() }}</span> <span class="x" @click="closeDetail">×</span></header>
        <div class="body" v-if="detailLoading"><div class="center-pad"><span class="spinner"></span> 加载中…</div></div>
        <div class="body" v-else-if="detail">
          <div class="detail-tabs">
            <button :class="{ on: detailTab === 'overview' }" @click="setDetailTab('overview')">概览</button>
            <button :class="{ on: detailTab === 'actions' }" @click="setDetailTab('actions')">操作</button>
            <button :class="{ on: detailTab === 'config' }" @click="setDetailTab('config')">配置</button>
            <button :class="{ on: detailTab === 'runtime' }" @click="setDetailTab('runtime')">运行时配置</button>
            <button :class="{ on: detailTab === 'commit' }" @click="setDetailTab('commit')">提交为镜像</button>
            <button :class="{ on: detailTab === 'update' }" @click="setDetailTab('update')">更新镜像</button>
          </div>

          <div v-if="detailTab === 'overview'" class="detail-tab-body">
            <div class="kv">
              <div class="k">容器 ID</div><div class="mono">{{ detail.Id }}</div>
              <div class="k">状态原文</div><div class="mono">{{ dState().Status || '-' }}</div>
              <div class="k">状态</div><div><span class="badge" :class="stateOf({ state: dState().Status })">{{ dState().Status || '-' }}</span> <span class="muted-sm" v-if="dState().Running">PID {{ dState().Pid }}</span></div>
              <div class="k">镜像</div><div class="mono">{{ dConfig().Image || '-' }}</div>
              <div class="k">创建时间</div><div>{{ detail.Created }}</div>
              <div class="k">启动命令</div><div class="mono">{{ (dConfig().Cmd || []).join(' ') || '-' }}</div>
              <div class="k">重启次数</div><div>{{ detail.RestartCount != null ? detail.RestartCount : '-' }}</div>
              <div class="k">退出码</div><div>{{ dState().ExitCode != null ? dState().ExitCode : '-' }}</div>
              <div class="k">OOMKilled</div><div>{{ dState().OOMKilled ? '是' : '否' }}</div>
              <div class="k">标签数量</div><div>{{ detailLabelCount() }}</div>
            </div>

            <h4 class="section-h">端口映射</h4>
            <table class="tbl" v-if="detailPorts().length">
              <thead><tr><th>容器端口</th><th>宿主机</th></tr></thead>
              <tbody><tr v-for="(p, i) in detailPorts()" :key="i"><td class="mono">{{ p.container }}</td><td class="mono">{{ p.host }}</td></tr></tbody>
            </table>
            <p v-else class="muted-sm">无端口映射</p>

            <h4 class="section-h">环境变量</h4>
            <div v-if="detailEnv().length" class="code-box" style="white-space:pre-wrap">{{ detailEnv().join('\\n') }}</div>
            <p v-else class="muted-sm">无</p>

            <h4 class="section-h">元数据标签</h4>
            <div v-if="detailLabelCount()" class="label-list">
              <div class="label-item" v-for="(l, i) in detailLabelList()" :key="i">
                <span class="label-key mono">{{ l.key }}</span><span class="label-eq">=</span><span class="label-val mono">{{ l.value }}</span>
              </div>
            </div>
            <p v-else class="muted-sm">无</p>

            <h4 class="section-h">网络</h4>
            <table class="tbl" v-if="detailNetworks().length">
              <thead><tr><th>网络</th><th>IP 地址</th><th>网关</th><th>MAC</th></tr></thead>
              <tbody><tr v-for="n in detailNetworks()" :key="n.name"><td>{{ n.name }}</td><td class="mono">{{ n.IPAddress || '-' }}</td><td class="mono">{{ n.Gateway || '-' }}</td><td class="mono">{{ n.MacAddress || '-' }}</td></tr></tbody>
            </table>
            <p v-else class="muted-sm">无</p>

            <h4 class="section-h">存储 / 挂载</h4>
            <table class="tbl" v-if="detailMounts().length">
              <thead><tr><th>类型</th><th>来源</th><th>容器内路径</th><th>模式</th></tr></thead>
              <tbody><tr v-for="(m, i) in detailMounts()" :key="i"><td>{{ m.type }}</td><td class="mono ellipsis">{{ m.source }}</td><td class="mono">{{ m.dest }}</td><td>{{ m.mode || '-' }}</td></tr></tbody>
            </table>
            <p v-else class="muted-sm">无挂载</p>
          </div>


          <div v-else-if="detailTab === 'actions'" class="detail-tab-body">
            <p class="page-sub" style="margin-top:0">容器生命周期与维护操作。启动 / 停止 / 暂停 / 重启 / 删除 / 重设 / 重命名 / 终端。</p>
            <div class="detail-actions">
              <button class="btn sm" :disabled="detailBusy || dIsRunning()" @click="detailAction('start')">启动</button>
              <button class="btn sm" :disabled="detailBusy || !dIsRunning()" @click="detailAction('stop')">停止</button>
              <button class="btn sm" v-if="dIsRunning()" :disabled="detailBusy" @click="detailAction('pause')">暂停</button>
              <button class="btn sm" v-else-if="dIsPaused()" :disabled="detailBusy" @click="detailAction('unpause')">恢复</button>
              <button class="btn sm" v-else disabled>暂停</button>
              <button class="btn sm" :disabled="detailBusy || !dIsRunning()" @click="detailAction('restart')">重启</button>
              <button class="btn sm danger" :disabled="detailBusy" @click="detailRemove">删除</button>
              <button class="btn sm" :disabled="detailBusy" @click="openRebuildSettings(detailC())">重设</button>
              <button class="btn sm" :disabled="detailBusy" @click="openRename(detailC())">重命名</button>
              <button class="btn sm" :disabled="detailBusy" @click="openTerminal(detailC())">终端</button>
            </div>
          </div>

          <div v-else-if="detailTab === 'config'" class="detail-tab-body">
            <p class="page-sub" style="margin-top:0">修改启动命令 / 环境变量 / 标签 / 重启策略 / 自动删除，保存后按新配置删除并重建容器（沿用原镜像 / 网络 / 存储）。</p>
            <label class="fld"><span>重启策略</span>
              <select v-model="configForm.restart">
                <option value="no">不重启</option><option value="on-failure">失败时重启</option><option value="always">总是重启</option><option value="unless-stopped">除非手动停止</option>
              </select></label>
            <label class="fld"><span><input type="checkbox" v-model="configForm.autoRemove" style="width:auto;margin-right:6px">退出后自动删除</span></label>
            <label class="fld"><span>启动命令（空格分隔，留空沿用镜像默认）</span><input v-model="configForm.cmd" placeholder="nginx -g 'daemon off;'"></label>
            <label class="fld"><span>环境变量（每行 KEY=VALUE）</span><textarea v-model="configForm.env" rows="3" placeholder="TZ=Asia/Shanghai&#10;NODE_ENV=production"></textarea></label>
            <label class="fld"><span>标签（每行 KEY=VALUE）</span><textarea v-model="configForm.labels" rows="2" placeholder="com.example.app=web"></textarea></label>
            <div v-if="configErr" style="color:#e5484d;font-size:13px">{{ configErr }}</div>
            <footer>
              <button class="btn" @click="setDetailTab('overview')">取消</button>
              <button class="btn primary" :disabled="configuring" @click="doConfig">{{ configuring ? '重建中…' : '保存并重配' }}</button>
            </footer>
          </div>

          <div v-else-if="detailTab === 'runtime'" class="detail-tab-body">
            <p class="page-sub" style="margin-top:0">实时修改 CPU / 内存 / 重启策略，容器不会中断。</p>
            <label class="fld"><span>内存上限 (MB，留空=不限制)</span><input v-model="runtimeForm.memoryMb" type="number" min="1" placeholder="如 512"></label>
            <label class="fld"><span>CPU 配额 (核数，如 0.5 / 1 / 2，留空=不限制)</span><input v-model="runtimeForm.cpuCores" type="number" step="0.1" min="0.1" placeholder="如 1"></label>
            <label class="fld"><span>CPU 绑定核心 (可选，如 0-1 或 1)</span><input v-model="runtimeForm.cpuset" placeholder="留空=不限制"></label>
            <label class="fld"><span>重启策略</span>
              <select v-model="runtimeForm.restart"><option value="no">不重启</option><option value="on-failure">失败时重启</option><option value="always">总是重启</option><option value="unless-stopped">除非手动停止</option></select></label>
            <label class="fld" v-if="runtimeForm.restart==='on-failure'"><span>最大重试次数</span><input v-model="runtimeForm.maxRetry" type="number" min="0"></label>
            <footer>
              <button class="btn" @click="setDetailTab('overview')">取消</button>
              <button class="btn primary" :disabled="runtimeSaving" @click="applyRuntime">{{ runtimeSaving ? '应用中…' : '应用' }}</button>
            </footer>
          </div>

          <div v-else-if="detailTab === 'commit'" class="detail-tab-body">
            <p class="page-sub" style="margin-top:0">将当前容器文件系统保存为新镜像（docker commit）。</p>
            <label class="fld"><span>仓库名 (可选，如 myapp)</span><input v-model="commitForm.repo" placeholder="留空则只生成镜像 ID"></label>
            <label class="fld"><span>标签</span><input v-model="commitForm.tag" placeholder="latest"></label>
            <label class="fld"><span>提交信息 (可选)</span><input v-model="commitForm.message" placeholder="如 初始化版本"></label>
            <label class="fld"><span>作者 (可选)</span><input v-model="commitForm.author" placeholder="如 user"></label>
            <footer>
              <button class="btn" @click="setDetailTab('overview')">取消</button>
              <button class="btn primary" :disabled="commitSaving" @click="applyCommit">{{ commitSaving ? '提交中…' : '提交' }}</button>
            </footer>
          </div>


          <div v-else-if="detailTab === 'update'" class="detail-tab-body">
            <p>拉取该镜像的最新版本，并按原配置（端口 / 卷 / 环境变量 / 标签 / 重启策略 / 网络）重建容器。当前容器将被删除后重新创建并启动。</p>
            <p class="muted-sm">镜像：<span class="mono">{{ dConfig().Image }}</span></p>
            <button class="btn primary" :disabled="updating" @click="updateImage">{{ updating ? '已提交…' : '更新镜像并重建' }}</button>
          </div>
        </div>
        <footer><button class="btn" @click="closeDetail">关闭</button></footer>
      </div>
    </div>
  </div>`,
};

// ---------------------------------------------------------------- Images
export const ImagesView = {
  data() {
    return {
      list: [], loading: false,
      q: '', statusFilter: 'all', sortBy: 'created', page: 1, pageSize: 20, sel: [],
      // 镜像更新检测结果（由后端定时 / 手动检测写入），用于镜像行标记"可更新"
      updateInfo: { checkedAt: 0, byRef: {} }, checkingUpdates: false,
      showPull: false, pullRepo: '', pulling: false, pullRegistrySel: '1panel', pullRegistryCustom: '', showBuildDf: false, buildDfText: '', buildDfTag: '', buildDfArgs: '', buildingDf: false,
      editImg: null, showTag: false, tagTarget: '',
      showPushTo: false, pushTarget: '', showInspect: false, inspectData: null, inspectLoading: false, showHistory: false, historyData: null, historyLoading: false, historyRepo: '',
      buildImg: null, building: false, buildInspecting: false, importing: false,
      form: { image: '', name: '', ports: [{ host: '', container: '', proto: 'tcp' }], volumes: [{ win: '', container: '', mode: 'rw' }], env: [{ key: '', value: '' }], labels: [{ key: '', value: '' }], restart: 'no', cmd: '', autoRemove: false },
      fsOpen: false, fsItems: [], fsCurrent: '', fsTarget: -1, fsMode: 'dir', fsLoading: false,
    };
  },
  computed: {
    // 一条镜像可能有多个 tag，列表按「仓库:标签」拆成多行展示（与 Docker Desktop / Portainer 一致）
    imgRows() {
      const rows = [];
      for (const img of this.list || []) {
        const refs = (img.RepoTags || []).filter((x) => x && x !== '<none>:<none>');
        if (!refs.length) {
          rows.push({ key: img.Id + ':none', img, repo: '悬空镜像', tag: '<none>', dangling: true });
        } else {
          for (const ref of refs) {
            const slash = ref.lastIndexOf('/');
            const colon = ref.lastIndexOf(':');
            const repo = colon > slash ? ref.slice(0, colon) : ref;
            const tag = colon > slash ? ref.slice(colon + 1) : 'latest';
            rows.push({ key: img.Id + ':' + ref, img, repo, tag, dangling: false });
          }
        }
      }
      let out = rows;
      if (this.statusFilter === 'inuse') out = out.filter((r) => r.img.inUse);
      else if (this.statusFilter === 'unused') out = out.filter((r) => !r.img.inUse);
      else if (this.statusFilter === 'dangling') out = out.filter((r) => r.dangling);
      const q = (this.q || '').trim().toLowerCase();
      if (q) out = out.filter((r) => (r.repo + ':' + r.tag).toLowerCase().indexOf(q) >= 0);
      const key = this.sortBy;
      return out.slice().sort((a, b) => {
        if (key === 'size') return (b.img.Size || 0) - (a.img.Size || 0);
        if (key === 'repo') {
          // 悬空镜像没有真实仓库名，按仓库排序时固定排在最后
          if (a.dangling !== b.dangling) return a.dangling ? 1 : -1;
          return a.repo.localeCompare(b.repo);
        }
        if (key === 'used') return (b.img.inUse ? 1 : 0) - (a.img.inUse ? 1 : 0);
        return (b.img.Created || 0) - (a.img.Created || 0);
      });
    },
    imgTotalSize() {
      const seen = {};
      let n = 0;
      for (const img of this.list || []) {
        if (seen[img.Id]) continue;
        seen[img.Id] = 1;
        n += img.Size || 0;
      }
      return n;
    },
    imgTotalCount() { return (this.list || []).length; },
    imgPages() { return Math.max(1, Math.ceil(this.imgRows.length / this.pageSize)); },
    imgPaged() {
      const s = (this.page - 1) * this.pageSize;
      return this.imgRows.slice(s, s + this.pageSize);
    },
    allSelected() {
      const rows = this.imgPaged;
      return rows.length > 0 && rows.every((r) => this.sel.indexOf(r.img.Id) >= 0);
    },
  },
  mounted() { this.load(); },
  methods: {
    when(sec) {
      if (!sec) return '-';
      const d = new Date(sec * 1000);
      const p = (n) => (n < 10 ? '0' + n : '' + n);
      return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    },
    // ---- 列表：多选 / 排序 / 分页 ----
    isSel(id) { return this.sel.indexOf(id) >= 0; },
    toggleSel(id) {
      const i = this.sel.indexOf(id);
      if (i >= 0) this.sel.splice(i, 1); else this.sel.push(id);
    },
    toggleAll() {
      const ids = this.imgPaged.map((r) => r.img.Id);
      if (this.allSelected) this.sel = this.sel.filter((x) => ids.indexOf(x) < 0);
      else { for (const id of ids) if (this.sel.indexOf(id) < 0) this.sel.push(id); }
    },
    setSort(k) { this.sortBy = k; this.page = 1; },
    async batchRemove() {
      if (!this.sel.length) return;
      const inUseCount = (this.list || []).filter((im) => this.sel.indexOf(im.Id) >= 0 && im.inUse).length;
      const deletable = this.sel.filter((id) => { const im = (this.list || []).find((x) => x.Id === id); return im && !im.inUse; });
      if (!deletable.length) { toast('选中的镜像全部正在被容器使用，无法删除。请先删除相关容器。', 'err'); return; }
      if (!confirmDanger('确认删除选中的 ' + deletable.length + ' 个镜像？' + (inUseCount ? ('（已自动跳过 ' + inUseCount + ' 个使用中镜像）') : ''))) return;
      let ok = 0;
      this.sel = [];
      for (const id of deletable) {
        try { await api.removeImage(id); ok++; } catch (_) { /* 单个失败不影响其他 */ }
      }
      toast('已提交 ' + ok + ' / ' + deletable.length + ' 个删除任务', ok ? 'ok' : 'err');
      setTimeout(() => this.load(), 1200);
    },
    // ---- 镜像更新检测相关 ----
    // 该镜像行（repo:tag）是否存在可更新版本（依据后端检测结果）
    hasUpdate(r) {
      if (r.dangling) return false;
      const ref = r.repo + ':' + r.tag;
      const info = this.updateInfo && this.updateInfo.byRef && this.updateInfo.byRef[ref];
      return !!(info && info.hasUpdate);
    },
    // 行内"更新"：拉取该 tag 的最新版本（覆盖本地镜像）
    async updateImageRow(r) {
      if (r.dangling) return;
      const ref = r.repo + ':' + r.tag;
      if (!confirmDanger('拉取镜像最新版本 ' + ref + '？本地该 tag 将更新为远端最新镜像。')) return;
      try {
        const rr = await api.pullImage(ref);
        toast('已提交拉取任务，详见右下角后台任务', 'ok');
        if (rr && rr.taskId) {
          whenTaskDone(rr.taskId, () => {
            // 拉取成功后本地 digest 已变化，乐观清除该引用"可更新"标记
            if (this.updateInfo.byRef) this.updateInfo.byRef[ref] = { hasUpdate: false };
            this.load();
          });
        } else this.load();
      } catch (e) { toast(e.message, 'err'); }
    },
    // 触发后端镜像更新检测（后台任务），完成后刷新徽标
    async checkUpdates() {
      if (this.checkingUpdates) return;
      this.checkingUpdates = true;
      try {
        const r = await api.checkImageUpdates();
        toast('正在后台检测镜像更新…', 'ok');
        whenTaskDone(r.taskId, async () => {
          this.updateInfo = await api.getImageUpdates().catch(() => this.updateInfo);
          this.load();
        });
      } catch (e) { toast(e.message, 'err'); }
      finally { this.checkingUpdates = false; }
    },
    // 批量更新：对选中的、含有效引用的镜像逐个拉取最新版本
    async batchUpdate() {
      if (!this.sel.length) return;
      const refs = this.imgRows.filter((r) => !r.dangling && this.sel.indexOf(r.img.Id) >= 0).map((r) => r.repo + ':' + r.tag);
      const uniq = Array.from(new Set(refs));
      if (!uniq.length) { toast('选中的镜像没有可更新的引用（悬空镜像无法更新）', 'err'); return; }
      if (!confirmDanger('确认对选中的 ' + uniq.length + ' 个镜像引用拉取最新版本？')) return;
      let ok = 0;
      this.sel = [];
      for (const ref of uniq) {
        try { const rr = await api.pullImage(ref); if (rr && rr.taskId) whenTaskDone(rr.taskId, () => this.load()); ok++; }
        catch (_) { /* 单个失败不影响其他 */ }
      }
      toast('已提交 ' + ok + ' / ' + uniq.length + ' 个镜像更新任务', ok ? 'ok' : 'err');
    },
    clearSel() { this.sel = []; },
    async load() {
      this.loading = true;
      try {
        this.list = await api.listImages();
        const ids = (this.list || []).map((im) => im.Id);
        this.sel = this.sel.filter((id) => ids.indexOf(id) >= 0);
        if (this.page > this.imgPages) this.page = this.imgPages;
      }
      catch (e) { toast(e.message, 'err'); }
      finally { this.loading = false; }
      // 拉取镜像更新检测结果，用于标记"可更新"徽标
      try { this.updateInfo = await api.getImageUpdates(); } catch (_) {}
    },
    tags(img) { return (img.RepoTags || ['<none>:<none>']).join(', '); },
    async remove(img) {
      if (img.inUse) { toast('该镜像正在被容器使用，无法删除。请先删除或移除引用它的容器。', 'err'); return; }
      if (!confirmDanger('确认删除该镜像？')) return;
      try { const r = await api.removeImage(img.Id); toast('删除任务已创建', 'ok'); this.afterTask(r, '镜像已删除', '删除镜像失败'); }
      catch (e) { toast(e.message, 'err'); }
    },
    async prune() {
      if (!confirmDanger('确认清理所有悬空镜像？')) return;
      try { const r = await api.pruneImages(); toast('清理任务已创建', 'ok'); this.afterTask(r, '悬空镜像已清理', '清理失败'); }
      catch (e) { toast(e.message, 'err'); }
    },
    async pull() {
      if (!this.pullRepo) { toast('请输入镜像名', 'err'); return; }
      const repoTag = this.pullRepo.trim();
      // 1Panel 经 NAS 实测支持「前缀形式」直拉：docker.1panel.live/<repo>，
      // 这里把 1panel 当作 registry 前缀交给后端 qualifyImage 拼接即可（无需改 daemon.json）。
      const reg = this.pullRegistrySel === '1panel' ? 'docker.1panel.live' :
                  this.pullRegistrySel === 'custom' ? (this.pullRegistryCustom || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '') :
                  '';
      this.pulling = true;
      try {
        const r = await api.pullImage(repoTag, reg);
        toast('拉取任务已创建，详见右下角后台任务', 'ok');
        this.showPull = false;
        const target = (reg ? reg + '/' : '') + repoTag;
        whenTaskDone(r.taskId, async (t) => {
          if (t && t.status === 'error') {
            toast('拉取失败：' + (t.error || '未知错误') + '（可点右下角任务明细看日志，或「镜像源设置→开始诊断」查连通性）', 'err');
          } else {
            await new Promise((r) => setTimeout(r, 800));
            await this.load();
            const bare = repoTag.replace(/^[^/]+\//, '') + (repoTag.includes(':') ? '' : ':latest');
            const matched = (this.list || []).find((im) => (im.RepoTags || []).some((tg) => tg === target || tg === bare || tg.endsWith('/' + bare)));
            if (matched) {
              toast('拉取完成，镜像已就绪：' + (matched.RepoTags || []).join(' / '), 'ok');
            } else {
              toast('拉取任务成功，但列表未匹配到「' + target + '」。若列表中已有「' + bare + '」，即为该镜像（1Panel 代理落地标签通常不带回前缀）', 'ok');
            }
          }
          this.load();
        });
      }
      catch (e) { toast(e.message, 'err'); }
      finally { this.pulling = false; }
    },
    afterTask(r, okMsg, errHint) {
      whenTaskDone(r.taskId, (t) => {
        if (t && t.status === 'error') {
          toast((errHint || '操作失败') + '：' + (t.error || '未知错误'), 'err');
        } else if (okMsg) {
          toast(okMsg, 'ok');
        }
        this.load();
      });
    },
    // ---- 编辑功能：标记 / 导出 / 提取 / 推送 / 检测 ----
    openEdit(img) {
      this.editImg = img;
      this.showTag = false; this.tagTarget = '';
      this.showPushTo = false; this.pushTarget = '';
      this.showInspect = false; this.inspectData = null;
    },
    closeEdit() { this.editImg = null; },
    async removeFromEdit() { const img = this.editImg; this.closeEdit(); if (img) await this.remove(img); },
    safeName(img) {
      return ((img.RepoTags && img.RepoTags[0]) || img.Id || 'image').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
    },
    async doTag() {
      if (!this.tagTarget || !this.tagTarget.trim()) { toast('请输入目标引用（如 linuxserver/jackett:1.0）', 'err'); return; }
      try {
        const r = await api.tagImage(this.editImg.Id, this.tagTarget.trim());
        toast('标记任务已创建', 'ok');
        this.showTag = false; this.tagTarget = '';
        this.afterTask(r, '已创建新版本标记', '标记失败');
      } catch (e) { toast(e.message, 'err'); }
    },
    async doExport() {
      try {
        await api.exportImage(this.editImg.Id, 'image_' + this.safeName(this.editImg) + '.tar');
        toast('已开始导出，浏览器将下载 tar 归档', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    },
    async doExtract() {
      try {
        await api.extractImage(this.editImg.Id, 'rootfs_' + this.safeName(this.editImg) + '.tar');
        toast('已开始提取，浏览器将下载根文件系统 tar', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    },
    async doPushDirect() {
      try {
        const r = await api.pushImage(this.editImg.Id);
        toast('推送任务已创建', 'ok');
        this.afterTask(r, '推送完成', '推送失败');
      } catch (e) { toast(e.message, 'err'); }
    },
    async doPushTo() {
      if (!this.pushTarget || !this.pushTarget.trim()) { toast('请输入目标引用', 'err'); return; }
      try {
        const r = await api.pushImage(this.editImg.Id, this.pushTarget.trim());
        toast('推送任务已创建', 'ok');
        this.showPushTo = false; this.pushTarget = '';
        this.afterTask(r, '推送完成', '推送失败');
      } catch (e) { toast(e.message, 'err'); }
    },
    async doInspect() {
      this.inspectLoading = true; this.showInspect = true; this.inspectData = null;
      try { this.inspectData = await api.inspectImage(this.editImg.Id); }
      catch (e) { toast(e.message, 'err'); }
      finally { this.inspectLoading = false; }
    },
    closeInspect() { this.showInspect = false; this.inspectData = null; },
    async openHistory(img) {
      this.historyRepo = (img.RepoTags && img.RepoTags[0]) || (img.Id || '').slice(7, 19);
      this.historyLoading = true; this.showHistory = true; this.historyData = null;
      try { this.historyData = await api.imageHistory((img.Id || '')); }
      catch (e) { toast(e.message, 'err'); }
      finally { this.historyLoading = false; }
    },
    closeHistory() { this.showHistory = false; this.historyData = null; },

    // ---- 构建：用该镜像设置配置并运行（创建+启动）容器 ----
    buildImageRef(img) {
      const t = (img.RepoTags || []).find((x) => x && x !== '<none>:<none>');
      return t || (img.Id || '');
    },
    async openBuild(img) {
      this.buildImg = img;
      this.building = false;
      this.form = { image: this.buildImageRef(img), name: '', ports: [{ host: '', container: '', proto: 'tcp' }], volumes: [{ win: '', container: '', mode: 'rw' }], env: [{ key: '', value: '' }], labels: [{ key: '', value: '' }], restart: 'no', cmd: '', autoRemove: false };
      this.form.name = await this.suggestName(img);
      this.prefillFromImage(img);
    },
    // 用镜像名生成「合法且不与现有容器重名」的默认容器名。
    // Docker 要求容器名至少 2 个字符、只能含 [a-zA-Z0-9_.-]，否则会返回 400。
    async suggestName(img) {
      let base = String(this.buildImageRef(img) || 'app').split('@')[0];
      const slash = base.lastIndexOf('/');
      const colon = base.lastIndexOf(':');
      if (colon > slash) base = base.slice(0, colon);
      base = base.slice(base.lastIndexOf('/') + 1).toLowerCase();
      base = base.replace(/[^a-z0-9_.-]/g, '-').replace(/-+/g, '-').replace(/^[-_.]+/, '').replace(/[-_.]+$/, '');
      if (base.length < 2) base = 'app-' + (base || 'x');
      let names = [];
      try {
        const cts = await api.listContainers();
        names = (cts || []).map((c) => String((c.names && c.names[0]) || '').toLowerCase());
      } catch (_) { /* 取不到容器列表时不做去重 */ }
      if (names.indexOf(base) < 0) return base;
      for (let i = 2; i < 500; i++) {
        const n = base + '-' + i;
        if (names.indexOf(n) < 0) return n;
      }
      return base + '-' + String(Date.now()).slice(-5);
    },
    closeBuild() { this.buildImg = null; this.fsOpen = false; this.rebuildSourceId = null; },
    async prefillFromImage(img) {
      let info;
      this.buildInspecting = true;
      try { info = await api.inspectImage(img.Id); }
      catch (e) { toast('读取镜像内部设置失败，将使用空白表单：' + e.message, 'err'); return; }
      finally { this.buildInspecting = false; }
      const cfg = (info && info.Config) || {};
      // 端口：从 ExposedPorts 预填（host 默认等同容器端口）
      const exposed = cfg.ExposedPorts ? Object.keys(cfg.ExposedPorts) : [];
      this.form.ports = exposed.length ? exposed.map((k) => {
        const [c, proto] = k.split('/');
        return { host: c, container: c, proto: (proto || 'tcp').toLowerCase() };
      }) : [{ host: '', container: '', proto: 'tcp' }];
      // 环境变量：从 Config.Env 预填 KEY=VALUE
      this.form.env = (cfg.Env && cfg.Env.length) ? cfg.Env.map((s) => {
        const i = s.indexOf('=');
        return { key: i >= 0 ? s.slice(0, i) : s, value: i >= 0 ? s.slice(i + 1) : '' };
      }) : [{ key: '', value: '' }];
      // 存储：从 Config.Volumes 预填 hostPath:containerPath（host 端给一个默认可改路径）
      const vols = cfg.Volumes ? Object.keys(cfg.Volumes) : [];
      this.form.volumes = vols.length ? vols.map((cv) => ({
        win: 'D:\\WslDockerManager\\data\\volumes\\' + this.safeName(img) + cv.replace(/\//g, '\\'),
        container: cv, mode: 'rw',
      })) : [{ win: '', container: '', mode: 'rw' }];
      // 元数据标签：从 Config.Labels 预填
      const lbls = cfg.Labels ? Object.keys(cfg.Labels).map((k) => ({ key: k, value: cfg.Labels[k] })) : [];
      this.form.labels = lbls.length ? lbls : [{ key: '', value: '' }];
    },
    // ---- 构建表单：逐行增删 ----
    addPort() { this.form.ports.push({ host: '', container: '', proto: 'tcp' }); },
    removePort(i) { this.form.ports.splice(i, 1); if (!this.form.ports.length) this.addPort(); },
    addVolume() { this.form.volumes.push({ win: '', container: '', mode: 'rw' }); },
    removeVolume(i) { this.form.volumes.splice(i, 1); if (!this.form.volumes.length) this.addVolume(); },
    addEnv() { this.form.env.push({ key: '', value: '' }); },
    removeEnv(i) { this.form.env.splice(i, 1); if (!this.form.env.length) this.addEnv(); },
    addLabel() { this.form.labels.push({ key: '', value: '' }); },
    removeLabel(i) { this.form.labels.splice(i, 1); if (!this.form.labels.length) this.addLabel(); },
    // ---- 卷绑定路径选择器（后端目录/文件浏览，返回绝对路径）----
    async openFolderPicker(index, mode) {
      this.fsTarget = index; this.fsMode = mode === 'file' ? 'file' : 'dir'; this.fsOpen = true; this.fsLoading = true;
      try {
        const base = (this.form.volumes[index].win && this.form.volumes[index].win.trim()) || 'D:\\WslDockerManager\\data\\volumes';
        const r = await api.fsList(base);
        this.fsCurrent = r.path; this.fsItems = this.normEntries(r.entries);
      } catch (e) {
        try { const r = await api.fsList(''); this.fsCurrent = r.path; this.fsItems = this.normEntries(r.entries); }
        catch (_) { this.fsItems = []; this.fsCurrent = ''; toast('无法列出目录：' + e.message, 'err'); }
      } finally { this.fsLoading = false; }
    },
    normEntries(entries) {
      // 兼容新旧后端：旧后端返回字符串数组（仅目录），新后端返回 {name,dir} 数组
      return (entries || []).map((e) => (typeof e === 'string' ? { name: e, dir: true } : e));
    },
    async fsList(p) {
      this.fsLoading = true;
      try { const r = await api.fsList(p); this.fsCurrent = r.path; this.fsItems = this.normEntries(r.entries); }
      catch (e) { toast('无法列出目录：' + e.message, 'err'); }
      finally { this.fsLoading = false; }
    },
    fsUp() { const parent = this.fsCurrent.replace(/[\\/][^\\/]+$/, ''); if (parent) this.fsList(parent); },
    fsEnter(name) { this.fsList(this.fsCurrent + '\\' + name); },
    fsPick(name) {
      if (this.fsTarget >= 0) this.form.volumes[this.fsTarget].win = this.fsCurrent + '\\' + name;
      this.fsOpen = false; this.fsTarget = -1; this.fsMode = 'dir';
    },
    fsPickCurrent() {
      if (this.fsTarget >= 0) this.form.volumes[this.fsTarget].win = this.fsCurrent;
      this.fsOpen = false; this.fsTarget = -1; this.fsMode = 'dir';
    },
    fsRowClick(it) {
      if (it.dir) { this.fsEnter(it.name); return; }
      if (this.fsMode === 'file') this.fsPick(it.name);
    },
    fsRowClass(it) {
      if (it.dir) return {};
      return { 'fs-file': true, 'fs-selectable': this.fsMode === 'file' };
    },
    async build() {
      const f = this.form;
      if (!f.image) { toast('请填写镜像', 'err'); return; }
      const cname = (f.name || '').trim();
      if (cname && cname.length < 2) { toast('容器名「' + cname + '」太短：Docker 要求至少 2 个字符，例如 ' + cname + '01', 'err'); return; }
      if (cname && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(cname)) { toast('容器名只能包含字母、数字、下划线、点、连字符，且必须以字母或数字开头', 'err'); return; }
      const ports = f.ports.filter((p) => p.host && p.container).map((p) => ({ host: p.host, container: p.container, proto: p.proto || 'tcp' }));
      const binds = f.volumes.filter((v) => v.win && v.container).map((v) => ({ win: v.win, container: v.container, mode: v.mode || 'rw' }));
      const env = f.env.filter((e) => e.key).map((e) => e.key + '=' + e.value);
      const labels = {};
      f.labels.filter((l) => l.key).forEach((l) => { labels[l.key] = l.value; });
      const spec = {
        image: f.image, name: cname || undefined,
        cmd: f.cmd ? f.cmd.split(/\s+/) : undefined,
        env,
        labels,
        ports, binds, restartPolicy: f.restart, networkMode: 'bridge',
        autoRemove: f.autoRemove, privileged: false,
      };
      // 若是「使用此镜像重新设置」重建：先删除原容器，再创建（同名替换）
      if (this.rebuildSourceId) {
        try {
          const rr = await api.removeContainer(this.rebuildSourceId, { force: 1, v: 1 });
          await new Promise((res) => whenTaskDone(rr.taskId, () => res(), 180000));
        } catch (e) { toast('删除原容器失败，仍尝试创建新容器：' + e.message, 'err'); }
      }
      this.building = true;
      try {
        const r = await api.createContainer(spec);
        toast('构建任务已创建，容器将启动', 'ok');
        this.closeBuild();
        this.rebuildSourceId = null;
        whenTaskDone(r.taskId, (t) => {
          if (t && t.status === 'error') toast('构建失败：' + (t.error || '未知错误'), 'err');
          else toast('容器已构建并启动：' + (cname || f.image), 'ok');
          this.load();
        });
      }
      catch (e) { toast(e.message, 'err'); }
      finally { this.building = false; }
    },

    // ---- 镜像导入（docker load） ----
    openImport() { if (this.$refs.importInput) this.$refs.importInput.click(); },
    async onImportFile(e) {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      if (!/\.tar(\.gz)?$/i.test(file.name)) { toast('请选择 .tar 镜像文件', 'err'); return; }
      if (!confirmDanger('确认导入镜像文件 ' + file.name + '？（将执行 docker load）')) return;
      this.importing = true;
      try { const r = await api.importImage(file); toast('导入任务已创建', 'ok'); whenTaskDone(r.taskId, () => this.load()); }
      catch (er) { toast(er.message, 'err'); }
      finally { this.importing = false; }
    },
    openBuildDf() {
      this.showBuildDf = true;
      this.buildDfText = 'FROM nginx:alpine\n\n# 在这里编写你的 Dockerfile\n';
      this.buildDfTag = '';
      this.buildDfArgs = '';
      this.buildingDf = false;
    },
    async submitBuildDf() {
      if (!this.buildDfText.trim()) { toast('Dockerfile 不能为空', 'err'); return; }
      if (!this.buildDfTag.trim()) { toast('镜像标签不能为空', 'err'); return; }
      const args = {};
      (this.buildDfArgs || '').split('\n').map((x) => x.trim()).filter(Boolean).forEach((line) => {
        const i = line.indexOf('=');
        if (i > 0) args[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      });
      this.buildingDf = true;
      try { const r = await api.buildImageFromDockerfile(this.buildDfText, this.buildDfTag.trim(), args); toast('构建任务已创建', 'ok'); whenTaskDone(r.taskId, () => this.load()); this.showBuildDf = false; }
      catch (e) { toast(e.message, 'err'); }
      finally { this.buildingDf = false; }
    },
  },
  template: `
  <div class="view">
    <input ref="importInput" type="file" accept=".tar,.tar.gz,application/x-tar" style="display:none" @change="onImportFile">
    <div class="page-head">
      <div>
        <h2 class="page-title" style="margin:0">镜像</h2>
        <p class="page-sub" style="margin:2px 0 0">管理本地 Docker 镜像</p>
        <div class="head-chips">
          <span class="chip">共 <b>{{ imgTotalCount }}</b> 个镜像</span>
          <span class="chip gray">总计 {{ fmtBytes(imgTotalSize) }}</span>
          <span class="chip ok" v-if="sel.length"><i class="dot"></i>已选 <b>{{ sel.length }}</b></span>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn primary" @click="showPull=true">+ 拉取镜像</button>
        <button class="btn" @click="prune">清理悬空</button>
        <button class="btn" @click="load">刷新</button>
        <button class="btn" @click="openBuildDf">从 Dockerfile 构建</button>
        <button class="btn" @click="openImport">导入镜像</button>
      </div>
    </div>

    <div class="toolbar">
      <div class="filter-bar">
        <input class="search" v-model="q" @input="page = 1" placeholder="搜索仓库或版本…">
        <select class="sel-sm" v-model="statusFilter" @change="page = 1">
          <option value="all">全部状态</option>
          <option value="inuse">使用中</option>
          <option value="unused">未使用</option>
          <option value="dangling">悬空镜像</option>
        </select>
        <select class="sel-sm" v-model="sortBy" @change="page = 1">
          <option value="created">按创建时间</option>
          <option value="size">按大小</option>
          <option value="repo">按仓库名</option>
          <option value="used">按使用状态</option>
        </select>
        <button class="btn sm" :disabled="checkingUpdates" @click="checkUpdates" title="逐个比对本地镜像与远端 registry 的 digest，标记可更新的镜像">{{ checkingUpdates ? '检测中…' : '检查镜像更新' }}</button>
      </div>
      <div class="muted-sm">共 {{ imgRows.length }} 条记录</div>
    </div>

    <div v-if="sel.length" class="batch-bar">
      <span class="batch-info">已选 <b>{{ sel.length }}</b> 个镜像</span>
      <button class="btn sm primary" @click="batchUpdate">批量更新</button>
      <button class="btn sm danger" @click="batchRemove">批量删除</button>
      <button class="btn sm" @click="clearSel">取消选择</button>
    </div>

    <div v-if="loading" class="center-pad"><span class="spinner"></span> 加载中…</div>
    <div v-else-if="!list.length" class="empty">没有镜像。点击右上角「拉取镜像」。</div>
    <div v-else class="view-body">
        <div class="card tbl-wrap list-scroll">
      <table class="tbl modern">
        <thead>
          <tr>
            <th class="c-sel"><input type="checkbox" :checked="allSelected" @change="toggleAll"></th>
            <th class="sortable" @click="setSort('repo')">仓库 <span class="caret" :class="{ on: sortBy === 'repo' }">▾</span></th>
            <th>标签</th>
            <th class="sortable" @click="setSort('used')">状态 <span class="caret" :class="{ on: sortBy === 'used' }">▾</span></th>
            <th class="sortable c-num" @click="setSort('size')">大小 <span class="caret" :class="{ on: sortBy === 'size' }">▾</span></th>
            <th class="sortable" @click="setSort('created')">创建时间 <span class="caret" :class="{ on: sortBy === 'created' }">▾</span></th>
            <th class="c-act">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in imgPaged" :key="r.key">
            <td class="c-sel"><input type="checkbox" :checked="isSel(r.img.Id)" @change="toggleSel(r.img.Id)"></td>
            <td>
              <div class="cell-main">
                <span class="ico-box">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 3 4 7.5v9L12 21l8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/></svg>
                </span>
                <div class="cell-text">
                  <div class="name mono">{{ r.repo }}</div>
                  <div class="sub mono">{{ (r.img.Id || '').slice(7, 19) }}</div>
                </div>
              </div>
            </td>
            <td>
              <span class="pill tag" v-if="!r.dangling">{{ r.tag }}</span>
              <span class="pill gray" v-else>悬空</span>
              <span v-if="hasUpdate(r)" class="update-badge" title="检测到该镜像有新版可用，点击右侧「更新」拉取最新版本">可更新</span>
            </td>
            <td>
              <span class="pill" :class="r.img.inUse ? 'ok' : 'gray'"><i class="dot"></i>{{ r.img.inUse ? '使用中' : '未使用' }}</span>
            </td>
            <td class="c-num nowrap">{{ fmtBytes(r.img.Size) }}</td>
            <td class="nowrap">{{ when(r.img.Created) }}</td>
            <td>
              <div class="act-row">
                <button v-if="hasUpdate(r)" class="btn sm primary" @click="updateImageRow(r)">更新</button>
                <button class="btn sm primary" @click="openBuild(r.img)">构建</button>
                <button class="btn sm" @click="openEdit(r.img)">编辑</button>
                <button class="btn sm" @click="openHistory(r.img)">历史</button>
                <button class="btn sm danger" :disabled="r.img.inUse" :title="r.img.inUse ? '该镜像正在被容器使用，无法删除（请先删除相关容器）' : '删除镜像'" @click="remove(r.img)">删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      </div><!-- /list-scroll -->
      <div class="pager">
        <span class="pg-count">共 <b>{{ imgRows.length }}</b> 条 · 每页 {{ pageSize }} 行</span>
        <div class="pager-btns">
          <button class="btn sm pg-btn" :disabled="page <= 1" @click="page = page - 1"><span class="pg-chev">‹</span> 上一页</button>
          <span class="pg-ind">第 <b>{{ page }}</b> / {{ imgPages }} 页</span>
          <button class="btn sm pg-btn" :disabled="page >= imgPages" @click="page = page + 1">下一页 <span class="pg-chev">›</span></button>
        </div>
      </div>
    </div>
    <div v-if="showPull" class="modal-mask" @click.self="showPull=false">
      <div class="modal">
        <header>拉取镜像 <span class="x" @click="showPull=false">×</span></header>
        <div class="body">
          <label class="fld"><span>镜像名:标签</span><input v-model="pullRepo" placeholder="nginx:alpine 或 linuxserver/jackett"></label>
          <label class="fld"><span>拉取源</span>
            <select v-model="pullRegistrySel">
              <option value="1panel">1Panel 镜像源 (docker.1panel.live/ 前缀，已在你的 NAS 验证可用)</option>
              <option value="hub">Docker Hub（默认，直连需 VPN）</option>
              <option value="custom">自定义 registry（前缀形式，如 127.0.0.1:5000）</option>
            </select>
          </label>
          <label class="fld" v-if="pullRegistrySel==='custom'"><span>自定义 registry</span><input v-model="pullRegistryCustom" placeholder="如 mirror.example.com 或 127.0.0.1:5000"></label>
        </div>
        <footer><button class="btn" @click="showPull=false">取消</button><button class="btn primary" :disabled="pulling" @click="pull">{{ pulling?'拉取中…':'拉取' }}</button></footer>
      </div>
    </div>

    <div v-if="editImg" class="modal-mask" @click.self="closeEdit">
      <div class="modal wide">
        <header>编辑镜像 <span class="mono" style="font-weight:normal">{{ tags(editImg) }}</span> <span class="x" @click="closeEdit">×</span></header>
        <div class="body">
          <div class="kv">
            <div class="k">标签 / 版本</div><div class="mono">{{ tags(editImg) }}</div>
            <div class="k">使用中</div><div><span class="badge" :class="editImg.inUse ? 'in-use' : 'unused'">{{ editImg.inUse ? '使用中' : '未使用' }}</span></div>
            <div class="k">ID</div><div class="mono">{{ (editImg.Id||'').slice(7,19) }}</div>
            <div class="k">大小</div><div>{{ fmtBytes(editImg.Size) }}</div>
          </div>
          <div class="edit-actions">
            <button class="btn sm" @click="showTag=!showTag">标记（修改版本）</button>
            <button class="btn sm" @click="doExport">导出镜像</button>
            <button class="btn sm" @click="doExtract">提取根文件系统</button>
            <button class="btn sm" @click="doPushDirect">直接推送</button>
            <button class="btn sm" @click="showPushTo=!showPushTo">推送到储存库</button>
            <button class="btn sm" @click="doInspect">检测</button>
          </div>
          <div v-if="showTag" class="subform">
            <label class="fld"><span>新版本引用（repo:tag，可含 registry，如 docker.1panel.live/linuxserver/jackett:1.0）</span><input v-model="tagTarget" placeholder="如 linuxserver/jackett:2024.1"></label>
            <div class="btn-row"><button class="btn sm" @click="showTag=false">取消</button><button class="btn sm primary" @click="doTag">创建标记</button></div>
          </div>
          <div v-if="showPushTo" class="subform">
            <label class="fld"><span>目标储存库引用（含 registry/namespace/repo:tag）</span><input v-model="pushTarget" placeholder="如 docker.1panel.live/linuxserver/jackett:mytag"></label>
            <div class="btn-row"><button class="btn sm" @click="showPushTo=false">取消</button><button class="btn sm primary" @click="doPushTo">推送</button></div>
          </div>
          <p class="page-sub" style="margin-top:10px">提示：导出 = 完整镜像归档（可 docker load 还原）；提取 = 镜像根文件系统 tar；推送需目标 registry 已在 WSL 内 docker login。</p>
        </div>
        <footer>
          <button class="btn danger" @click="removeFromEdit">删除镜像</button>
          <button class="btn" @click="closeEdit">关闭</button>
        </footer>
      </div>
    </div>

    <div v-if="showInspect" class="modal-mask" @click.self="closeInspect">
      <div class="modal wide">
        <header>检测镜像 <span class="mono" style="font-weight:normal">{{ editImg ? tags(editImg) : '' }}</span> <span class="x" @click="closeInspect">×</span></header>
        <div class="body">
          <div v-if="inspectLoading" class="center-pad"><span class="spinner"></span> 检测中…</div>
          <template v-else-if="inspectData">
            <div class="kv">
              <div class="k">架构 / OS</div><div>{{ inspectData.Architecture || '-' }} / {{ inspectData.Os || '-' }}</div>
              <div class="k">大小</div><div>{{ fmtBytes(inspectData.Size) }}</div>
              <div class="k">虚拟大小</div><div>{{ fmtBytes(inspectData.VirtualSize) }}</div>
              <div class="k">创建时间</div><div>{{ inspectData.Created }}</div>
              <div class="k">作者</div><div>{{ inspectData.Author || '-' }}</div>
              <div class="k">入口命令</div><div class="mono">{{ (inspectData.Entrypoint || []).join(' ') || '-' }}</div>
              <div class="k">默认 Cmd</div><div class="mono">{{ (inspectData.Cmd || []).join(' ') || '-' }}</div>
              <div class="k">暴露端口</div><div class="mono">{{ inspectData.Config && inspectData.Config.ExposedPorts ? Object.keys(inspectData.Config.ExposedPorts).join(', ') : '-' }}</div>
              <div class="k">环境变量</div><div class="mono" style="white-space:pre-wrap">{{ (inspectData.Config && inspectData.Config.Env || []).join('\\n') || '-' }}</div>
            </div>
            <h4 style="margin:14px 0 6px">原始 inspect（JSON）</h4>
            <pre class="code-box">{{ JSON.stringify(inspectData, null, 2) }}</pre>
          </template>
        </div>
        <footer><button class="btn" @click="closeInspect">关闭</button></footer>
      </div>
    </div>

    <div v-if="showHistory" class="modal-mask" @click.self="closeHistory">
      <div class="modal wide">
        <header>镜像历史（构建层） <span class="mono" style="font-weight:normal">{{ historyRepo }}</span> <span class="x" @click="closeHistory">×</span></header>
        <div class="body">
          <div v-if="historyLoading" class="center-pad"><span class="spinner"></span> 加载中…</div>
          <div v-else-if="!historyData || !historyData.length" class="empty">无历史数据。</div>
          <ol v-else class="layer-list">
            <li v-for="(l, i) in historyData" :key="i" class="layer">
              <div class="layer-id mono">{{ (l.Id || '').replace('sha256:', '').slice(0, 16) }}</div>
              <div class="layer-body">
                <div class="layer-cmd mono">{{ l.CreatedBy || '(无命令)' }}</div>
                <div class="layer-meta">大小 {{ fmtBytes(l.Size || 0) }} · 创建于 {{ when(l.Created) }}</div>
              </div>
            </li>
          </ol>
        </div>
        <footer><button class="btn" @click="closeHistory">关闭</button></footer>
      </div>
    </div>

    <div v-if="buildImg" class="modal-mask" @click.self="closeBuild">
      <div class="modal">
        <header>构建容器 · <span class="mono" style="font-weight:normal">{{ buildImg ? tags(buildImg) : '' }}</span> <span class="x" @click="closeBuild">×</span></header>
        <div class="body">
          <p class="page-sub" style="margin-top:0">使用该镜像创建并启动容器。已自动读取镜像内部的<b>端口 / 环境变量 / 存储路径</b>并逐行预填，确认或按需增减后点击"构建并运行"。<span v-if="buildInspecting" style="color:#ffb454">（正在读取镜像内部设置…）</span></p>
          <label class="fld"><span>镜像 (必填)</span><input v-model="form.image" placeholder="nginx:alpine"></label>
          <label class="fld"><span>名称（已按镜像名自动生成，可改；至少 2 个字符）</span><input v-model="form.name" placeholder="例如 nginx"></label>

          <div class="section-label">端口映射 <button class="btn sm" @click="addPort">+ 添加</button></div>
          <div class="rows">
            <div class="kv-row" v-for="(p, i) in form.ports" :key="'port'+i">
              <input class="cell host" v-model="p.host" placeholder="主机端口">
              <input class="cell host" v-model="p.container" placeholder="容器端口">
              <select class="cell proto" v-model="p.proto"><option value="tcp">tcp</option><option value="udp">udp</option></select>
              <button class="btn sm danger" @click="removePort(i)">删除</button>
            </div>
          </div>

          <div class="section-label">卷绑定 <button class="btn sm" @click="addVolume">+ 添加</button></div>
          <p class="page-sub" style="margin:2px 0 6px">前面为本地路径（留空即不挂载该路径），后面为容器内路径。支持<b>文件夹对文件夹</b>或<b>文件对文件</b>两种绑定：点"选择文件夹"浏览目录，点"选择文件"可直接选中单个文件（如 <span class="mono">C:\\app\\conf.json : /app/conf.json</span>）。地址不存在时后端会自动创建。</p>
          <div class="rows">
            <div class="kv-row" v-for="(v, i) in form.volumes" :key="'vol'+i">
              <div class="vol-win">
                <input class="cell" v-model="v.win" placeholder="本地路径（文件夹或文件，留空=不挂载）">
                <button class="btn sm" @click="openFolderPicker(i, 'dir')">选择文件夹</button>
                <button class="btn sm" @click="openFolderPicker(i, 'file')">选择文件</button>
              </div>
              <input class="cell" v-model="v.container" placeholder="容器内路径 如 /data">
              <select class="cell proto" v-model="v.mode"><option value="rw">rw</option><option value="ro">ro</option></select>
              <button class="btn sm danger" @click="removeVolume(i)">删除</button>
            </div>
          </div>

          <div class="section-label">环境变量 <button class="btn sm" @click="addEnv">+ 添加</button></div>
          <div class="rows">
            <div class="kv-row" v-for="(e, i) in form.env" :key="'env'+i">
              <input class="cell" v-model="e.key" placeholder="KEY">
              <input class="cell" v-model="e.value" placeholder="VALUE">
              <button class="btn sm danger" @click="removeEnv(i)">删除</button>
            </div>
          </div>

          <div class="section-label">元数据标签 <button class="btn sm" @click="addLabel">+ 添加</button></div>
          <div class="rows">
            <div class="kv-row" v-for="(l, i) in form.labels" :key="'lbl'+i">
              <input class="cell" v-model="l.key" placeholder="标签键 (如 com.example.app)">
              <input class="cell" v-model="l.value" placeholder="标签值">
              <button class="btn sm danger" @click="removeLabel(i)">删除</button>
            </div>
          </div>

          <div class="row2">
            <label class="fld"><span>重启策略</span>
              <select v-model="form.restart"><option value="no">不重启</option><option value="on-failure">失败时重启</option><option value="always">总是重启</option><option value="unless-stopped">除非手动停止</option></select></label>
            <label class="fld"><span>启动命令 (可选, 空格分隔)</span><input v-model="form.cmd" placeholder="如 nginx -g 'daemon off;'"></label>
          </div>
          <label class="fld"><span><input type="checkbox" v-model="form.autoRemove" style="width:auto;margin-right:6px">退出后自动删除容器</span></label>
        </div>
        <footer>
          <button class="btn" @click="closeBuild">取消</button>
          <button class="btn primary" :disabled="building" @click="build">{{ building ? '构建中…' : '构建并运行' }}</button>
        </footer>
      </div>
    </div>

    <div v-if="fsOpen" class="modal-mask" @click.self="fsOpen=false">
      <div class="modal" style="max-width:560px">
        <header>{{ fsMode==='file' ? '选择本地文件' : '选择本地文件夹' }} <span class="mono" style="font-weight:normal;font-size:12px">{{ fsCurrent }}</span> <span class="x" @click="fsOpen=false">×</span></header>
        <div class="body" style="max-height:50vh;overflow:auto">
          <div class="fs-row up" @click="fsUp">..（上一级）</div>
          <template v-if="fsItems.length">
            <div class="fs-row" v-for="it in fsItems" :key="it.name" @click="fsRowClick(it)" :class="fsRowClass(it)">
              <span v-if="it.dir">📁 {{ it.name }}</span>
              <span v-else>📄 {{ it.name }}</span>
            </div>
          </template>
          <div v-else class="page-sub" style="padding:8px">（空目录或无权限）</div>
          <div v-if="fsLoading" class="page-sub" style="padding:8px">载入中…</div>
        </div>
        <footer>
          <button class="btn" @click="fsOpen=false">取消</button>
          <span class="page-sub" v-if="fsMode==='file'" style="margin-right:auto">点击文件即可选中（📄）</span>
          <button class="btn primary" @click="fsPickCurrent">选择当前目录</button>
        </footer>
      </div>
    </div>

    <div v-if="showBuildDf" class="modal-mask" @click.self="showBuildDf=false">
      <div class="modal wide">
        <header>从 Dockerfile 构建镜像 <span class="x" @click="showBuildDf=false">×</span></header>
        <div class="body">
          <label class="fld"><span>镜像标签 (repo:tag，如 myapp:1.0)</span><input v-model="buildDfTag" placeholder="myapp:1.0"></label>
          <label class="fld"><span>构建参数 (每行 KEY=VALUE，可选)</span><textarea v-model="buildDfArgs" rows="3" placeholder="VERSION=1.0"></textarea></label>
          <label class="fld"><span>Dockerfile</span><textarea v-model="buildDfText" rows="12" style="font-family:ui-monospace,Menlo,Consolas,monospace"></textarea></label>
        </div>
        <footer>
          <button class="btn" @click="showBuildDf=false">取消</button>
          <button class="btn primary" :disabled="buildingDf" @click="submitBuildDf">{{ buildingDf ? '构建中…' : '开始构建' }}</button>
        </footer>
      </div>
    </div>

  </div>`,
};

// ---------------------------------------------------------------- Volumes
export const VolumesView = {
  data() { return { volumes: [], warnings: [], loading: false, showCreate: false, form: { name: '', driver: 'local' }, sel: null, detail: null, detailLoading: false, backuping: false }; },
  mounted() { this.load(); },
  methods: {
    async load() {
      this.loading = true;
      try { const r = await api.listVolumes(); this.volumes = r.volumes || []; this.warnings = r.warnings || []; }
      catch (e) { toast(e.message, 'err'); }
      finally { this.loading = false; }
    },
    async remove(name) {
      if (!confirmDanger('确认删除卷 ' + name + '？数据将丢失。')) return;
      try { const r = await api.removeVolume(name); toast('删除任务已创建', 'ok'); whenTaskDone(r.taskId, () => this.load()); }
      catch (e) { toast(e.message, 'err'); }
    },
    async prune() {
      if (!confirmDanger('确认清理所有未使用卷？')) return;
      try { const r = await api.pruneVolumes(); toast('清理任务已创建', 'ok'); whenTaskDone(r.taskId, () => this.load()); }
      catch (e) { toast(e.message, 'err'); }
    },
    async create() {
      if (!this.form.name) { toast('请输入卷名', 'err'); return; }
      try { const r = await api.createVolume({ name: this.form.name, driver: this.form.driver }); toast('创建任务已创建', 'ok'); whenTaskDone(r.taskId, () => this.load()); this.showCreate = false; }
      catch (e) { toast(e.message, 'err'); }
    },
    async viewDetail(name) {
      this.sel = name; this.detailLoading = true; this.detail = null;
      try { this.detail = await api.inspectVolume(name); }
      catch (e) { toast(e.message, 'err'); }
      finally { this.detailLoading = false; }
    },
    async backup(name) {
      if (!name) return;
      this.backuping = true;
      try { await api.backupVolume(name, name + '.tar.gz'); toast('备份已开始下载', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
      finally { this.backuping = false; }
    },
    async onRestoreFile(name, e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (!confirmDanger('确认用该 tar.gz 覆盖恢复卷 ' + name + '？卷内现有数据将被清空替换。')) { e.target.value = ''; return; }
      try { const r = await api.restoreVolume(name, file); toast('恢复任务已创建', 'ok'); whenTaskDone(r.taskId, () => this.load()); }
      catch (e) { toast(e.message, 'err'); }
      finally { e.target.value = ''; }
    },
  },
  template: `
  <div class="view">
    <div class="toolbar">
      <div><h2 class="page-title" style="margin:0">卷</h2><p class="page-sub" style="margin:2px 0 0">命名卷（推荐用于数据库等需要持久化的数据）</p></div>
      <div class="btn-row">
        <button class="btn primary" @click="showCreate=true">+ 新建卷</button>
        <button class="btn" @click="prune">清理未用</button>
        <button class="btn" @click="load">刷新</button>
      </div>
    </div>
    <div v-if="loading" class="center-pad"><span class="spinner"></span> 加载中…</div>
    <div v-else-if="!volumes.length" class="empty">没有卷。</div>
    <div v-else class="card list-scroll" style="padding:0">
      <table class="tbl">
        <thead><tr><th>名称</th><th>驱动</th><th>挂载点</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="v in volumes" :key="v.Name">
            <td class="mono">{{ v.Name }}</td>
            <td>{{ v.Driver }}</td>
            <td class="mono" style="color:#8a909a">{{ v.Mountpoint }}</td>
            <td><div class="btn-row"><button class="btn sm" @click="viewDetail(v.Name)">详情</button><button class="btn sm danger" @click="remove(v.Name)">删除</button></div></td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="showCreate" class="modal-mask" @click.self="showCreate=false">
      <div class="modal">
        <header>新建卷 <span class="x" @click="showCreate=false">×</span></header>
        <div class="body">
          <label class="fld"><span>卷名</span><input v-model="form.name"></label>
          <label class="fld"><span>驱动</span><input v-model="form.driver"></label>
        </div>
        <footer><button class="btn" @click="showCreate=false">取消</button><button class="btn primary" @click="create">创建</button></footer>
      </div>
    </div>

    <div v-if="detail" class="modal-mask" @click.self="detail=null">
      <div class="modal">
        <header>卷详情：{{ sel }} <span class="x" @click="detail=null">×</span></header>
        <div class="body">
          <div v-if="detailLoading" class="center-pad"><span class="spinner"></span></div>
          <div v-else-if="detail" class="kv">
            <div class="k">名称</div><div class="mono">{{ detail.Name }}</div>
            <div class="k">驱动</div><div>{{ detail.Driver || '-' }}</div>
            <div class="k">挂载点</div><div class="mono" style="word-break:break-all">{{ detail.Mountpoint }}</div>
            <div class="k">创建时间</div><div>{{ detail.CreatedAt || '-' }}</div>
            <div class="k">原始 JSON</div><div><pre class="code-box" style="white-space:pre-wrap">{{ JSON.stringify(detail, null, 2) }}</pre></div>
          </div>
        </div>
        <footer>
          <button class="btn" :disabled="backuping" @click="backup(sel)">{{ backuping ? '备份中…' : '备份下载' }}</button>
          <button class="btn" @click="$refs.volRestore.click()">恢复</button>
          <input ref="volRestore" type="file" accept=".tar,.tar.gz,application/x-tar" style="display:none" @change="onRestoreFile(sel, $event)">
          <button class="btn" @click="detail=null">关闭</button>
        </footer>
      </div>
    </div>
  </div>`,
};

// ---------------------------------------------------------------- Networks
export const NetworksView = {
  data() { return { list: [], loading: false, showCreate: false, form: { name: '', driver: 'bridge' }, sel: null, detail: null, detailLoading: false, netConnectForm: { container: '', ipv4: '' }, netConnecting: false }; },
  mounted() { this.load(); },
  methods: {
    async load() {
      this.loading = true;
      try { this.list = await api.listNetworks(); }
      catch (e) { toast(e.message, 'err'); }
      finally { this.loading = false; }
    },
    async remove(id) {
      if (!confirmDanger('确认删除网络 ' + (id || '').slice(0, 12) + '？')) return;
      try { const r = await api.removeNetwork(id); toast('删除任务已创建', 'ok'); whenTaskDone(r.taskId, () => this.load()); }
      catch (e) { toast(e.message, 'err'); }
    },
    async prune() {
      if (!confirmDanger('确认清理所有未使用网络？')) return;
      try { const r = await api.pruneNetworks(); toast('清理任务已创建', 'ok'); whenTaskDone(r.taskId, () => this.load()); }
      catch (e) { toast(e.message, 'err'); }
    },
    async create() {
      if (!this.form.name) { toast('请输入网络名', 'err'); return; }
      try { const r = await api.createNetwork({ name: this.form.name, driver: this.form.driver }); toast('创建任务已创建', 'ok'); whenTaskDone(r.taskId, () => this.load()); this.showCreate = false; }
      catch (e) { toast(e.message, 'err'); }
    },
    async viewDetail(id) {
      this.sel = (id || '').slice(0, 12); this.detailLoading = true; this.detail = null;
      try { this.detail = await api.inspectNetwork(id); }
      catch (e) { toast(e.message, 'err'); }
      finally { this.detailLoading = false; }
    },
    async netConnect() {
      const id = this.detail && this.detail.Id;
      if (!id || !this.netConnectForm.container) return;
      this.netConnecting = true;
      try { const r = await api.networkConnect(id, this.netConnectForm.container.trim(), this.netConnectForm.ipv4.trim() || null); toast('接入任务已创建', 'ok'); whenTaskDone(r.taskId, () => this.viewDetail(id)); }
      catch (e) { toast(e.message, 'err'); }
      finally { this.netConnecting = false; this.netConnectForm = { container: '', ipv4: '' }; }
    },
    async netDisconnect(cid) {
      const id = this.detail && this.detail.Id;
      if (!id) return;
      if (!confirmDanger('确认将容器 ' + (cid || '').slice(0, 12) + ' 从网络断开？')) return;
      this.netConnecting = true;
      try { const r = await api.networkDisconnect(id, cid); toast('断开任务已创建', 'ok'); whenTaskDone(r.taskId, () => this.viewDetail(id)); }
      catch (e) { toast(e.message, 'err'); }
      finally { this.netConnecting = false; }
    },
  },
  template: `
  <div class="view">
    <div class="toolbar">
      <div><h2 class="page-title" style="margin:0">网络</h2><p class="page-sub" style="margin:2px 0 0">Docker 网络</p></div>
      <div class="btn-row">
        <button class="btn primary" @click="showCreate=true">+ 新建网络</button>
        <button class="btn" @click="prune">清理未用</button>
        <button class="btn" @click="load">刷新</button>
      </div>
    </div>
    <div v-if="loading" class="center-pad"><span class="spinner"></span> 加载中…</div>
    <div v-else-if="!list.length" class="empty">没有网络。</div>
    <div v-else class="card list-scroll" style="padding:0">
      <table class="tbl">
        <thead><tr><th>名称</th><th>ID</th><th>驱动</th><th>范围</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="n in list" :key="n.Id">
            <td>{{ n.Name }}</td>
            <td class="mono">{{ (n.Id||'').slice(0,12) }}</td>
            <td>{{ n.Driver }}</td>
            <td>{{ n.Scope }}</td>
            <td><div class="btn-row"><button class="btn sm" @click="viewDetail(n.Id)">详情</button><button class="btn sm danger" @click="remove(n.Id)">删除</button></div></td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="showCreate" class="modal-mask" @click.self="showCreate=false">
      <div class="modal">
        <header>新建网络 <span class="x" @click="showCreate=false">×</span></header>
        <div class="body">
          <label class="fld"><span>网络名</span><input v-model="form.name"></label>
          <label class="fld"><span>驱动</span><select v-model="form.driver"><option>bridge</option><option>overlay</option><option>host</option><option>none</option></select></label>
        </div>
        <footer><button class="btn" @click="showCreate=false">取消</button><button class="btn primary" @click="create">创建</button></footer>
      </div>
    </div>

    <div v-if="detail" class="modal-mask" @click.self="detail=null">
      <div class="modal">
        <header>网络详情：{{ sel }} <span class="x" @click="detail=null">×</span></header>
        <div class="body">
          <div v-if="detailLoading" class="center-pad"><span class="spinner"></span></div>
          <div v-else-if="detail" class="kv">
            <div class="k">名称</div><div>{{ detail.Name }}</div>
            <div class="k">ID</div><div class="mono">{{ (detail.Id || '').slice(0, 16) }}</div>
            <div class="k">驱动</div><div>{{ detail.Driver || '-' }}</div>
            <div class="k">范围</div><div>{{ detail.Scope || '-' }}</div>
            <div class="k">子网</div><div class="mono">{{ detail.IPAM && detail.IPAM.Config && detail.IPAM.Config[0] ? detail.IPAM.Config[0].Subnet : '-' }}</div>
            <div class="k">网关</div><div class="mono">{{ detail.IPAM && detail.IPAM.Config && detail.IPAM.Config[0] ? detail.IPAM.Config[0].Gateway : '-' }}</div>
          </div>
          <h4 class="section-h" v-if="detail && detail.Containers && Object.keys(detail.Containers).length">接入的容器</h4>
          <table class="tbl" v-if="detail && detail.Containers && Object.keys(detail.Containers).length">
            <thead><tr><th>容器</th><th>IPv4</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="(c, cid) in detail.Containers" :key="cid">
                <td class="mono">{{ c.Name }}</td>
                <td class="mono">{{ c.IPv4Address || '-' }}</td>
                <td><button class="btn sm danger" :disabled="netConnecting" @click="netDisconnect(cid)">断开</button></td>
              </tr>
            </tbody>
          </table>
          <p v-else-if="detail" class="muted-sm">无接入容器</p>
          <h4 class="section-h">接入容器</h4>
          <label class="fld"><span>容器名/ID</span><input v-model="netConnectForm.container" placeholder="容器名或完整 ID"></label>
          <label class="fld"><span>指定 IPv4（可选）</span><input v-model="netConnectForm.ipv4" placeholder="如 172.20.0.10"></label>
          <button class="btn primary" :disabled="!netConnectForm.container || netConnecting" @click="netConnect">{{ netConnecting ? '接入中…' : '接入网络' }}</button>
          <h4 class="section-h">原始 JSON</h4>
          <pre class="code-box" v-if="detail" style="white-space:pre-wrap">{{ JSON.stringify(detail, null, 2) }}</pre>
        </div>
        <footer><button class="btn" @click="detail=null">关闭</button></footer>
      </div>
    </div>
  </div>`,
};

// ---------------------------------------------------------------- Stacks (compose)
export const StacksView = {
  data() {
    return {
      stacks: [], loading: false,
      sel: null, detail: null, showEditor: false, editor: '', showSvcLogs: false, svcLogs: '', svcLogsLoading: false, svcName: '', svcStack: '',
      showLogs: false, logsText: '', logsLoading: false,
      showCreate: false, createName: '', createContent: 'services:\n  app:\n    image: nginx:alpine\n    ports:\n      - "8080:80"\n    volumes:\n      - /mnt/d/WslDockerManager/data/app:/usr/share/nginx/html:rw\n',
    };
  },
  mounted() { this.load(); },
  methods: {
    async load() {
      this.loading = true;
      try { const r = await api.listStacks(); this.stacks = r.stacks || []; }
      catch (e) { toast(e.message, 'err'); }
      finally { this.loading = false; }
    },
    async act(name, action) {
      try { const r = await api.stackAction(name, action); toast(action + ' 完成', 'ok'); await this.load(); }
      catch (e) { toast(e.message, 'err'); }
    },
    async remove(name) {
      if (!confirmDanger('确认删除栈 ' + name + '？（会先 down 再删除目录）')) return;
      try { await api.deleteStack(name); toast('已删除', 'ok'); await this.load(); }
      catch (e) { toast(e.message, 'err'); }
    },
    async viewDetail(name) {
      this.sel = name;
      try { this.detail = await api.getStack(name); this.showEditor = false; }
      catch (e) { toast(e.message, 'err'); }
    },
    openEditor() { this.editor = this.detail.content; this.showEditor = true; },
    async save() {
      try { await api.updateStack(this.sel, this.editor); toast('已保存', 'ok'); this.showEditor = false; this.detail = await api.getStack(this.sel); }
      catch (e) { toast(e.message, 'err'); }
    },
    async viewLogs(name) {
      this.sel = name; this.showLogs = true; this.logsText = ''; this.logsLoading = true;
      try { this.logsText = await api.stackLogs(name, { tail: 300 }); }
      catch (e) { this.logsText = '加载失败: ' + e.message; }
      finally { this.logsLoading = false; }
    },
    closeLogs() { this.showLogs = false; },
    async viewSvcLogs(name, service) {
      this.svcStack = name; this.svcName = service; this.showSvcLogs = true; this.svcLogs = ''; this.svcLogsLoading = true;
      try { this.svcLogs = await api.stackLogs(name, { service, tail: 500 }); }
      catch (e) { this.svcLogs = '加载失败: ' + e.message; }
      finally { this.svcLogsLoading = false; }
    },
    closeSvcLogs() { this.showSvcLogs = false; },
    async create() {
      if (!this.createName) { toast('请输入栈名', 'err'); return; }
      try { await api.createStack(this.createName, this.createContent); toast('已创建', 'ok'); this.showCreate = false; await this.load(); }
      catch (e) { toast(e.message, 'err'); }
    },
  },
  template: `
  <div class="view">
    <div class="toolbar">
      <div><h2 class="page-title" style="margin:0">Compose 栈</h2><p class="page-sub" style="margin:2px 0 0">每个栈 = data/compose/&lt;名称&gt;/docker-compose.yml，在 WSL 内运行</p></div>
      <div class="btn-row">
        <button class="btn primary" @click="showCreate=true">+ 新建栈</button>
        <button class="btn" @click="load">刷新</button>
      </div>
    </div>
    <div v-if="loading" class="center-pad"><span class="spinner"></span> 加载中…</div>
    <div v-else-if="!stacks.length" class="empty">还没有栈。把 docker-compose.yml 放进 data/compose/&lt;名称&gt;/ 目录，或点击"新建栈"。</div>
    <div v-else class="card list-scroll" style="padding:0">
      <table class="tbl">
        <thead><tr><th>名称</th><th>Compose 文件</th><th>容器</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="s in stacks" :key="s.name">
            <td><b>{{ s.name }}</b></td>
            <td class="mono" style="color:#8a909a">{{ s.composeFile }}</td>
            <td>{{ s.runningCount }}/{{ s.containerCount }}</td>
            <td><span class="badge" :class="s.status">{{ s.status }}</span></td>
            <td>
              <div class="btn-row">
                <button class="btn sm primary" @click="act(s.name,'up')">启动</button>
                <button class="btn sm" @click="act(s.name,'down')">停止</button>
                <button class="btn sm" @click="act(s.name,'restart')">重启</button>
                <button class="btn sm" @click="viewDetail(s.name)">详情</button>
                <button class="btn sm danger" @click="remove(s.name)">删</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="detail && !showEditor" class="modal-mask" @click.self="detail=null">
      <div class="modal">
        <header>栈详情：{{ sel }} <span class="x" @click="detail=null">×</span></header>
        <div class="body">
          <div class="toolbar">
            <div class="btn-row">
              <button class="btn sm primary" @click="act(sel,'up')">启动</button>
              <button class="btn sm" @click="act(sel,'down')">停止</button>
              <button class="btn sm" @click="act(sel,'restart')">重启</button>
              <button class="btn sm" @click="act(sel,'pull')">拉取</button>
              <button class="btn sm" @click="viewLogs(sel)">日志</button>
            </div>
            <button class="btn sm" @click="openEditor">编辑 compose</button>
          </div>
          <div class="kv">
            <div class="k">服务</div><div><div class="svc-list"><button v-for="sv in (detail.services||[])" :key="sv" class="svc-chip" @click="viewSvcLogs(sel, sv)"><span class="dot"></span>{{ sv }}<span class="svc-log">日志 ›</span></button></div></div>
            <div class="k">容器</div><div>{{ (detail.containers||[]).length }}</div>
          </div>
          <h4 style="margin:14px 0 6px">docker-compose.yml</h4>
          <pre class="code-box">{{ detail.content }}</pre>
        </div>
        <footer><button class="btn" @click="detail=null">关闭</button></footer>
      </div>
    </div>

    <div v-if="showEditor" class="modal-mask" @click.self="showEditor=false">
      <div class="modal">
        <header>编辑 compose：{{ sel }} <span class="x" @click="showEditor=false">×</span></header>
        <div class="body"><textarea v-model="editor" rows="20" style="width:100%"></textarea>
          <p class="page-sub" style="margin-top:6px">保存后旧文件会自动备份为 .bak。bind 路径请用 WSL 格式 /mnt/d/...</p></div>
        <footer><button class="btn" @click="showEditor=false">取消</button><button class="btn primary" @click="save">保存</button></footer>
      </div>
    </div>

    <div v-if="showSvcLogs" class="modal-mask" @click.self="closeSvcLogs">
      <div class="modal">
        <header>服务日志：{{ svcStack }} / {{ svcName }} <span class="x" @click="closeSvcLogs">×</span></header>
        <div class="body"><div v-if="svcLogsLoading" class="center-pad"><span class="spinner"></span></div><pre v-else class="code-box">{{ svcLogs || '(空)' }}</pre></div>
        <footer><button class="btn" @click="closeSvcLogs">关闭</button></footer>
      </div>
    </div>

    <div v-if="showLogs" class="modal-mask" @click.self="closeLogs">
      <div class="modal">
        <header>栈日志：{{ sel }} <span class="x" @click="closeLogs">×</span></header>
        <div class="body"><div v-if="logsLoading" class="center-pad"><span class="spinner"></span></div><pre v-else class="code-box">{{ logsText || '(空)' }}</pre></div>
        <footer><button class="btn" @click="closeLogs">关闭</button></footer>
      </div>
    </div>

    <div v-if="showCreate" class="modal-mask" @click.self="showCreate=false">
      <div class="modal">
        <header>新建栈 <span class="x" @click="showCreate=false">×</span></header>
        <div class="body">
          <label class="fld"><span>栈名（仅字母数字、-、_）</span><input v-model="createName" placeholder="my-app"></label>
          <label class="fld"><span>docker-compose.yml 内容</span><textarea v-model="createContent" rows="14" style="width:100%"></textarea></label>
        </div>
        <footer><button class="btn" @click="showCreate=false">取消</button><button class="btn primary" @click="create">创建</button></footer>
      </div>
    </div>
  </div>`,
};

const TASK_TYPE_LABEL = {
  'image.pull': '拉取镜像', 'image.remove': '删除镜像', 'image.prune': '清理悬空镜像',
  'image.tag': '标记镜像', 'image.push': '推送镜像', 'container.create': '创建容器',
  'container.start': '启动容器', 'container.stop': '停止容器', 'container.restart': '重启容器',
  'container.kill': '强杀容器', 'container.pause': '暂停容器', 'container.unpause': '恢复容器',
  'container.remove': '删除容器', 'container.recreate': '重构（重建）容器', 'container.update': '更新镜像重建容器',
  'volume.remove': '删除卷', 'volume.create': '新建卷', 'volume.prune': '清理卷',
  'network.remove': '删除网络', 'network.create': '新建网络', 'network.prune': '清理网络',
};

// Full-page live view of background tasks (same data as the collapsed dock, but
// expanded into a complete page with detail drawers).
export const TasksView = {
  data() {
    return { tasks: [], sel: null, detail: null, showDetail: false, busyId: null };
  },
  mounted() { this.timer = setInterval(() => this.refresh(), 1500); this.refresh(); },
  beforeUnmount() { if (this.timer) clearInterval(this.timer); },
  computed: {
    running() { return (this.tasks || []).filter((t) => t.status === 'running').length; },
  },
  methods: {
    async refresh() {
      try { const r = await api.listTasks(); this.tasks = (r && r.tasks) || []; } catch (e) {}
    },
    fmtTime(t) { return new Date(t).toLocaleString(); },
    fmtDur(t) { return ((t || 0) / 1000).toFixed(1) + 's'; },
    badge(t) { return t.status === 'success' ? 'ok' : t.status === 'error' ? 'err' : 'run'; },
    statusText(t) { return t.status === 'running' ? '运行中' : t.status === 'success' ? '成功' : '失败'; },
    typeLabel(t) { return TASK_TYPE_LABEL[t.type] || t.type; },
    logText(d) {
      if (!d || !d.log || !d.log.length) return '(空)';
      return d.log.map((l) => '[' + new Date(l.t).toLocaleTimeString() + '] ' + l.msg).join('\n');
    },
    async openDetail(id) {
      this.sel = id; this.busyId = id;
      try { this.detail = await api.getTask(id); } catch (e) { this.detail = null; }
      finally { this.busyId = null; }
      this.showDetail = true;
    },
    closeDetail() { this.showDetail = false; this.sel = null; this.detail = null; },
    async dismiss(id) { try { await api.removeTask(id); } catch (e) {} await this.refresh(); },
    async clear() { try { await api.clearTasks(); } catch (e) {} await this.refresh(); },
  },
  template: `
  <div class="view">
    <div class="toolbar">
      <div><h2 class="page-title" style="margin:0">后台任务</h2><p class="page-sub" style="margin:2px 0 0">实时后台操作任务（运行 {{ running }} 个），点击任意任务查看完整日志</p></div>
      <div class="btn-row">
        <button class="btn" @click="clear" :disabled="!tasks.length">清空已完成</button>
        <button class="btn" @click="refresh">刷新</button>
      </div>
    </div>
    <div v-if="!tasks.length" class="empty">暂无后台任务</div>
    <div v-else class="card list-scroll" style="padding:0">
      <table class="tbl">
        <thead><tr><th>状态</th><th>类型</th><th>标题</th><th>进度</th><th>创建时间</th><th></th></tr></thead>
        <tbody>
          <tr v-for="t in tasks" :key="t.id" class="task-row" :class="badge(t)" @click="openDetail(t.id)">
            <td><span class="td-badge" :class="badge(t)">{{ statusText(t) }}</span></td>
            <td>{{ typeLabel(t) }}</td>
            <td>{{ t.title }}</td>
            <td>
              <span v-if="t.progress != null">{{ t.progress }}%</span>
              <span v-else class="muted-sm">—</span>
            </td>
            <td class="muted-sm">{{ fmtTime(t.createdAt) }}</td>
            <td><button class="icon-btn" title="移除" @click.stop="dismiss(t.id)">×</button></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="showDetail" class="modal-mask" @click.self="closeDetail">
      <div class="modal">
        <header>任务明细：{{ detail ? typeLabel(detail) : '' }} <span class="x" @click="closeDetail">×</span></header>
        <div class="body">
          <div class="kv">
            <div class="k">状态</div><div><span class="td-badge" :class="detail ? badge(detail) : ''">{{ detail ? statusText(detail) : '' }}</span></div>
            <div class="k">标题</div><div>{{ detail && detail.title }}</div>
            <div class="k">类型</div><div class="mono">{{ detail && detail.type }}</div>
            <div class="k">ID</div><div class="mono">{{ detail && detail.id }}</div>
            <div class="k">创建时间</div><div>{{ detail ? fmtTime(detail.createdAt) : '' }}</div>
            <div class="k">耗时</div><div>{{ detail ? fmtDur((detail.updatedAt||detail.createdAt) - detail.createdAt) : '' }}</div>
            <div class="k" v-if="detail && detail.progress != null">进度</div>
            <div v-if="detail && detail.progress != null">{{ detail.progress }}%</div>
            <div class="k" v-if="detail && detail.error">错误</div>
            <div v-if="detail && detail.error" style="color:#e5484d;white-space:pre-wrap">{{ detail.error }}</div>
          </div>
          <h4 style="margin:14px 0 6px">日志</h4>
          <pre class="code-box td-log">{{ detail ? logText(detail) : '' }}</pre>
        </div>
        <footer><button class="btn" @click="closeDetail">关闭</button></footer>
      </div>
    </div>
  </div>`,
};

export const ContainerLogsView = {
  data() {
    return {
      logId: '', logName: '', logs: '', loading: false, error: '',
      follow: false, tail: 500, search: '', autoTimer: null, es: null,
    };
  },
  computed: {
    filteredLogs() {
      const s = (this.search || '').trim().toLowerCase();
      if (!s) return this.logs;
      return this.logs.split('\n').filter((l) => l.toLowerCase().includes(s)).join('\n');
    },
    lineCount() { return (this.filteredLogs || '').split('\n').length; },
  },
  mounted() {
    const m = (location.hash || '').match(/clogs\/([^/?#]+)/);
    this.logId = m ? decodeURIComponent(m[1]) : '';
    if (!this.logId) { this.error = '缺少容器 ID'; return; }
    this.loadName();
    this.load();
  },
  beforeUnmount() { this.stopFollow(); },
  methods: {
    async loadName() {
      try { const c = await api.inspectContainer(this.logId); this.logName = (c && (c.Name || c.name) || '').replace(/^\//, ''); }
      catch (e) { this.logName = ''; }
    },
    async load() {
      if (!this.logId) return;
      this.loading = true; this.error = '';
      try { this.logs = await api.containerLogsText(this.logId, { tail: this.tail, timestamps: true }); }
      catch (e) { this.error = e.message; }
      finally { this.loading = false; this.$nextTick(() => this.scrollBottom()); }
    },
    scrollBottom() { const el = this.$refs.logBody; if (el) el.scrollTop = el.scrollHeight; },
    openStream() {
      this.closeStream();
      if (!this.logId) return;
      const url = location.origin + '/api/containers/' + encodeURIComponent(this.logId) + '/logs/stream';
      try {
        const es = new EventSource(url);
        this.es = es;
        es.onmessage = (ev) => { if (ev.data) { this.logs = (this.logs ? this.logs + '\n' : '') + ev.data; this.$nextTick(() => this.scrollBottom()); } };
        es.onerror = () => {};
      } catch (e) { /* EventSource 不可用时退回轮询 */ }
    },
    closeStream() { if (this.es) { try { this.es.close(); } catch (e) {} this.es = null; } },
    toggleFollow() {
      if (this.follow) { this.stopFollow(); }
      else { this.follow = true; this.openStream(); if (!this.es) this.autoTimer = setInterval(() => this.load(), 3000); }
    },
    stopFollow() { this.follow = false; this.closeStream(); if (this.autoTimer) { clearInterval(this.autoTimer); this.autoTimer = null; } },
    async downloadLog() {
      try {
        const raw = await api.containerLogsText(this.logId, { tail: this.tail, timestamps: true });
        const blob = new Blob([raw], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (this.logName || this.logId.slice(0, 12)) + '.log';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        toast('已开始下载日志', 'ok');
      } catch (e) { toast('下载失败：' + e.message, 'err'); }
    },
    async copyLog() {
      try { await navigator.clipboard.writeText(this.filteredLogs || this.logs); toast('已复制日志', 'ok'); }
      catch (e) { toast('复制失败：' + e.message, 'err'); }
    },
    back() { if (this.$root && this.$root.nav) this.$root.nav('containers'); else location.hash = '#/containers'; },
    onTail() { this.load(); },
  },
  template: `
  <div class="log-page">
    <div class="log-head">
      <div class="lh-left">
        <button class="btn sm" @click="back">‹ 返回容器</button>
        <div class="lh-title">容器日志<template v-if="logName"> · <b>{{ logName }}</b></template></div>
        <span class="mono muted-sm">{{ logId }}</span>
      </div>
      <div class="lh-right">
        <label class="lg-inline">行数
          <select v-model.number="tail" @change="onTail">
            <option :value="100">100</option>
            <option :value="500">500</option>
            <option :value="2000">2000</option>
            <option :value="0">全部</option>
          </select>
        </label>
        <input class="lg-search" v-model="search" placeholder="搜索日志…">
        <button class="btn sm" :disabled="loading || !logId" @click="load">刷新</button>
        <button class="btn sm" :class="{active: follow}" @click="toggleFollow">{{ follow ? '停止刷新' : '自动刷新' }}</button>
        <button class="btn sm" @click="copyLog">复制</button>
        <button class="btn sm primary" @click="downloadLog">下载</button>
      </div>
    </div>
    <div class="log-body">
      <div v-if="loading && !logs" class="center-pad"><span class="spinner"></span> 加载中…</div>
      <div v-else-if="error" class="empty">加载失败：{{ error }}</div>
      <pre v-else ref="logBody" class="log-pre">{{ filteredLogs || '(空)' }}</pre>
    </div>
    <div class="log-foot muted-sm">共 {{ lineCount }} 行<template v-if="search">（已按关键词过滤）</template> · 自动刷新每 3 秒拉取最新日志并滚动到底部</div>
  </div>
  `,
};


export const UsersView = {
  data() {
    return {
      list: [], loading: false,
      showCreate: false, form: { username: '', password: '', role: 'user' }, createErr: '',
      showEdit: false, editUser: null, editRole: 'user', editPassword: '', editErr: '',
    };
  },
  mounted() { this.load(); },
  methods: {
    async load() {
      this.loading = true;
      try { const r = await api.listUsers(); this.list = r.users || []; }
      catch (e) { toast(e.message, 'err'); }
      finally { this.loading = false; }
    },
    openCreate() { this.form = { username: '', password: '', role: 'user' }; this.createErr = ''; this.showCreate = true; },
    closeCreate() { this.showCreate = false; },
    async createUser() {
      const f = this.form;
      if (!f.username || !f.password) { this.createErr = '用户名和密码必填'; return; }
      try { await api.createUser({ username: f.username, password: f.password, role: f.role }); toast('用户已创建', 'ok'); this.closeCreate(); this.load(); }
      catch (e) { this.createErr = e.message; }
    },
    openEdit(u) { this.editUser = u; this.editRole = u.role; this.editPassword = ''; this.editErr = ''; this.showEdit = true; },
    closeEdit() { this.showEdit = false; this.editUser = null; },
    async saveEdit() {
      const body = {};
      if (this.editRole !== this.editUser.role) body.role = this.editRole;
      if (this.editPassword) body.password = this.editPassword;
      if (!body.role && !body.password) { this.editErr = '未修改任何项'; return; }
      try { await api.updateUser(this.editUser.username, body); toast('已保存', 'ok'); this.closeEdit(); this.load(); }
      catch (e) { this.editErr = e.message; }
    },
    async resetPassword(u) {
      const pw = prompt('为「' + u.username + '」设置新密码（至少 4 个字符）：');
      if (pw === null) return;
      if (pw.length < 4) { toast('密码至少 4 个字符', 'err'); return; }
      try { await api.resetUserPassword(u.username, pw); toast('密码已重置', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    },
    async remove(u) {
      if (!confirmDanger('确认删除用户 ' + u.username + '？')) return;
      try { await api.deleteUser(u.username); toast('已删除', 'ok'); this.load(); }
      catch (e) { toast(e.message, 'err'); }
    },
  },
  template: `
  <div class="view">
    <div class="page-head">
      <div>
        <h2 class="page-title" style="margin:0">用户管理</h2>
        <p class="page-sub" style="margin:2px 0 0">管理系统登录账户与角色（管理员 / 普通用户）</p>
      </div>
      <div class="btn-row">
        <button class="btn primary" @click="openCreate">+ 新建用户</button>
        <button class="btn" @click="load">刷新</button>
      </div>
    </div>
    <div v-if="loading" class="center-pad"><span class="spinner"></span> 加载中…</div>
    <div v-else class="view-body">
      <div class="card tbl-wrap list-scroll">
        <table class="tbl modern">
          <thead><tr><th>用户名</th><th>角色</th><th class="c-act">操作</th></tr></thead>
          <tbody>
            <tr v-for="u in list" :key="u.username">
              <td class="mono">{{ u.username }}</td>
              <td><span class="pill" :class="u.role === 'admin' ? 'ok' : 'gray'"><i class="dot"></i>{{ u.role === 'admin' ? '管理员' : '普通用户' }}</span></td>
              <td>
                <div class="act-row">
                  <button class="btn sm" @click="openEdit(u)">编辑</button>
                  <button class="btn sm" @click="resetPassword(u)">重置密码</button>
                  <button class="btn sm danger" @click="remove(u)">删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="pager"><span class="pg-count">共 <b>{{ list.length }}</b> 个用户</span></div>
    </div>

    <div v-if="showCreate" class="modal-mask" @click.self="closeCreate">
      <div class="modal">
        <header>新建用户 <span class="x" @click="closeCreate">×</span></header>
        <div class="body">
          <label class="fld"><span>用户名</span><input v-model="form.username" placeholder="字母/数字/下划线/点/连字符"></label>
          <label class="fld"><span>密码（至少 4 个字符）</span><input type="password" v-model="form.password"></label>
          <label class="fld"><span>角色</span>
            <select v-model="form.role"><option value="user">普通用户</option><option value="admin">管理员</option></select>
          </label>
          <div v-if="createErr" style="color:#e5484d;font-size:13px">{{ createErr }}</div>
        </div>
        <footer><button class="btn" @click="closeCreate">取消</button><button class="btn primary" @click="createUser">创建</button></footer>
      </div>
    </div>

    <div v-if="showEdit" class="modal-mask" @click.self="closeEdit">
      <div class="modal">
        <header>编辑用户 · <span class="mono">{{ editUser && editUser.username }}</span> <span class="x" @click="closeEdit">×</span></header>
        <div class="body">
          <label class="fld"><span>角色</span>
            <select v-model="editRole"><option value="user">普通用户</option><option value="admin">管理员</option></select>
          </label>
          <label class="fld"><span>重置密码（留空则不修改）</span><input type="password" v-model="editPassword" placeholder="至少 4 个字符"></label>
          <div v-if="editErr" style="color:#e5484d;font-size:13px">{{ editErr }}</div>
        </div>
        <footer><button class="btn" @click="closeEdit">取消</button><button class="btn primary" @click="saveEdit">保存</button></footer>
      </div>
    </div>
  </div>`,
};


// ---------------------------------------------------- Interactive Terminal (P1: WebSocket)
// ---------------------------------------------------- Settings (扫描更新频率 + 自动更新)
export const SettingsView = {
  data() {
    return {
      scanIntervalMinutes: 360,
      autoUpdateEnabled: false,
      autoUpdateScope: 'running',
      loading: false, saving: false, savedAt: 0,
      msg: '', msgOk: true,
      // 镜像源管理（每个镜像源可单独登录）
      mirrorSources: [], mirrorAuths: [], mirrorLoading: false,
      newMirrorUrl: '', newMirrorUser: '', newMirrorPass: '', showMirrorCreds: false,
      addMirrorLoading: false, mirrorMsg: '', mirrorMsgOk: true,
      showLogin: false, loginHost: '', loginUser: '', loginPass: '', loginLoading: false,
      diagMirror: null, diagMirrorLoading: false,
    };
  },
  mounted() { this.load(); this.loadMirrorSources(); },
  computed: {
    intervalLabel() {
      const m = this.scanIntervalMinutes;
      if (!m || m <= 0) return '关闭';
      if (m >= 1440) return (m / 1440) + ' 天';
      if (m >= 60) return (m / 60) + ' 小时';
      return m + ' 分钟';
    },
  },
  methods: {
    async load() {
      this.loading = true; this.msg = '';
      try {
        const s = await api.getUpdateSettings();
        this.scanIntervalMinutes = s.scanIntervalMinutes || 0;
        this.autoUpdateEnabled = !!s.autoUpdateEnabled;
        this.autoUpdateScope = s.autoUpdateScope === 'all' ? 'all' : 'running';
      } catch (e) { this.msg = e.message; this.msgOk = false; }
      finally { this.loading = false; }
    },
    async save() {
      if (this.saving) return;
      this.saving = true; this.msg = '';
      try {
        await api.saveUpdateSettings({
          scanIntervalMinutes: Number(this.scanIntervalMinutes) || 0,
          autoUpdateEnabled: this.autoUpdateEnabled,
          autoUpdateScope: this.autoUpdateScope,
        });
        this.savedAt = Date.now();
        this.msg = '设置已保存，新的扫描频率立即生效'; this.msgOk = true;
        toast('设置已保存', 'ok');
      } catch (e) { this.msg = e.message; this.msgOk = false; }
      finally { this.saving = false; }
    },
    // ---- 镜像源管理 ----
    hostOf(url) { return String(url || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, ''); },
    async loadMirrorSources() {
      this.mirrorLoading = true;
      try {
        const r = await api.getMirrorSources();
        this.mirrorSources = r.mirrors || [];
        this.mirrorAuths = r.auths || [];
      } catch (e) { this.mirrorMsg = e.message; this.mirrorMsgOk = false; }
      finally { this.mirrorLoading = false; }
    },
    isLoggedIn(url) { return this.mirrorAuths.includes(this.hostOf(url)); },
    async addMirrorSource() {
      const url = (this.newMirrorUrl || '').trim();
      if (!url) { this.mirrorMsg = '请填写镜像源地址'; this.mirrorMsgOk = false; return; }
      if (!/^https?:\/\//i.test(url)) { this.mirrorMsg = '镜像源需以 http(s):// 开头，例如 https://docker.1panel.live'; this.mirrorMsgOk = false; return; }
      this.addMirrorLoading = true; this.mirrorMsg = '';
      try {
        const payload = { url };
        if (this.newMirrorUser.trim() && this.newMirrorPass) { payload.username = this.newMirrorUser.trim(); payload.password = this.newMirrorPass; }
        const r = await api.addMirrorSource(payload);
        this.mirrorSources = r.mirrors || [];
        this.mirrorAuths = r.auths || [];
        this.mirrorMsg = (r.message || '镜像源已添加') + '（已自动重启 Docker 生效）'; this.mirrorMsgOk = true;
        this.newMirrorUrl = ''; this.newMirrorUser = ''; this.newMirrorPass = ''; this.showMirrorCreds = false;
        toast('镜像源已添加', 'ok');
      } catch (e) { this.mirrorMsg = e.message; this.mirrorMsgOk = false; }
      finally { this.addMirrorLoading = false; }
    },
    async removeMirrorSource(url) {
      if (!confirmDanger('确认删除镜像源 ' + url + '？（将从 daemon.json 移除该 registry-mirrors 并重启 Docker）')) return;
      try {
        const r = await api.removeMirrorSource({ url });
        this.mirrorSources = r.mirrors || [];
        this.mirrorMsg = '已删除镜像源：' + url; this.mirrorMsgOk = true;
        toast('已删除镜像源', 'ok');
      } catch (e) { this.mirrorMsg = e.message; this.mirrorMsgOk = false; }
    },
    openLogin(host) { this.loginHost = host; this.loginUser = ''; this.loginPass = ''; this.showLogin = true; },
    closeLogin() { this.showLogin = false; },
    async doLogin() {
      if (!this.loginUser.trim() || !this.loginPass) { this.mirrorMsg = '用户名与密码均为必填'; this.mirrorMsgOk = false; return; }
      this.loginLoading = true; this.mirrorMsg = '';
      try {
        await api.registryLogin({ registry: this.loginHost, username: this.loginUser.trim(), password: this.loginPass });
        const r = await api.getMirrorSources();
        this.mirrorSources = r.mirrors || []; this.mirrorAuths = r.auths || [];
        this.mirrorMsg = '已登录：' + this.loginHost; this.mirrorMsgOk = true;
        toast('登录成功', 'ok');
        this.showLogin = false;
      } catch (e) { this.mirrorMsg = '登录失败：' + e.message; this.mirrorMsgOk = false; }
      finally { this.loginLoading = false; }
    },
    async doLogout(host) {
      if (!confirmDanger('确认退出镜像源 ' + host + ' 的登录？')) return;
      try {
        await api.registryLogout({ registry: host });
        const r = await api.getMirrorSources();
        this.mirrorSources = r.mirrors || []; this.mirrorAuths = r.auths || [];
        this.mirrorMsg = '已退出登录：' + host; this.mirrorMsgOk = true;
        toast('已退出登录', 'ok');
      } catch (e) { this.mirrorMsg = '退出失败：' + e.message; this.mirrorMsgOk = false; }
    },
    async runDiagMirror() {
      this.diagMirrorLoading = true; this.diagMirror = null;
      try { this.diagMirror = await api.diagnoseMirror(); }
      catch (e) { this.mirrorMsg = '诊断失败：' + e.message; this.mirrorMsgOk = false; }
      finally { this.diagMirrorLoading = false; }
    },
  },
  template: `
  <div class="view scroll">
    <div class="page-head">
      <div>
        <h2 class="page-title" style="margin:0">设置</h2>
        <p class="page-sub" style="margin:2px 0 0">镜像更新扫描频率与自动更新策略</p>
      </div>
      <div class="btn-row">
        <button class="btn" @click="load" :disabled="loading">重新加载</button>
        <button class="btn primary" @click="save" :disabled="saving">{{ saving ? '保存中…' : '保存设置' }}</button>
      </div>
    </div>

    <div v-if="msg" class="banner" :style="{ background: msgOk ? 'rgba(16,185,129,0.08)' : 'rgba(229,72,77,0.08)', color: msgOk ? '#047857' : '#b91c1c', border: '1px solid ' + (msgOk ? 'rgba(16,185,129,0.3)' : 'rgba(229,72,77,0.3)') }">{{ msg }}</div>

    <div class="card" style="max-width:760px">
      <div style="margin-bottom:18px">
        <div style="font-weight:600;font-size:14px;margin-bottom:4px">扫描更新频率</div>
        <div class="muted-sm" style="margin-bottom:8px">按设定间隔自动比对本地镜像与远端 registry 的 digest，标记"可更新"容器。设为"关闭"则仅在页面手动点击"检查镜像更新"时检测。</div>
        <select class="sel-sm" v-model.number="scanIntervalMinutes">
          <option :value="0">关闭自动扫描</option>
          <option :value="360">每 6 小时</option>
          <option :value="720">每 12 小时</option>
          <option :value="1440">每天</option>
          <option :value="10080">每周</option>
        </select>
      </div>

      <div style="margin-bottom:18px">
        <div style="font-weight:600;font-size:14px;margin-bottom:4px">自动更新镜像</div>
        <div class="muted-sm" style="margin-bottom:8px">开启后，自动扫描发现可更新版本时，会拉取最新镜像并按原配置（端口 / 卷 / 环境变量 / 重启策略 / 网络）自动重建对应容器。</div>
        <select class="sel-sm" v-model="autoUpdateEnabled">
          <option :value="false">关闭（仅标记可更新，手动更新）</option>
          <option :value="true">开启（发现更新自动重建容器）</option>
        </select>
      </div>

      <div style="margin-bottom:18px" v-show="autoUpdateEnabled">
        <div style="font-weight:600;font-size:14px;margin-bottom:4px">自动更新范围</div>
        <div class="muted-sm" style="margin-bottom:8px">选择自动更新覆盖哪些容器。</div>
        <select class="sel-sm" v-model="autoUpdateScope">
          <option value="running">仅运行中容器</option>
          <option value="all">全部容器（含已停止）</option>
        </select>
      </div>

      <div style="border-top:1px solid var(--border);padding-top:14px">
        <div style="font-weight:600;font-size:14px;margin-bottom:8px">当前设置</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <span class="chip">扫描频率：<b>{{ intervalLabel }}</b></span>
          <span class="chip" :class="autoUpdateEnabled ? 'ok' : 'gray'"><i class="dot"></i>自动更新：<b>{{ autoUpdateEnabled ? '开启' : '关闭' }}</b></span>
        </div>
        <div class="muted-sm" v-if="savedAt" style="margin-top:8px">已于 {{ new Date(savedAt).toLocaleString() }} 保存</div>
      </div>

      <div class="card" style="max-width:760px;margin-top:18px">
        <div style="font-weight:600;font-size:14px;margin-bottom:4px">镜像源管理</div>
        <div class="muted-sm" style="margin-bottom:12px">配置拉取镜像时使用的镜像源（写入 WSL daemon.json 的 registry-mirrors），保存后自动重启 Docker 生效。每个镜像源可单独登录：需要鉴权的私有 / 代理镜像源在此登录；公开镜像源（如 1Panel 镜像源 docker.1panel.live）无需登录即可直接使用。</div>
        <div v-if="mirrorMsg" class="banner" :style="{ background: mirrorMsgOk ? 'rgba(16,185,129,0.08)' : 'rgba(229,72,77,0.08)', color: mirrorMsgOk ? '#047857' : '#b91c1c', border: '1px solid ' + (mirrorMsgOk ? 'rgba(16,185,129,0.3)' : 'rgba(229,72,77,0.3)') }">{{ mirrorMsg }}</div>

        <!-- 已配置镜像源列表 -->
        <div v-if="mirrorLoading" class="muted-sm">加载中…</div>
        <div v-else-if="!mirrorSources.length" class="muted-sm" style="margin-bottom:12px">（暂无镜像源，请在下方添加）</div>
        <div v-else class="reg-list" style="margin-bottom:14px">
          <div class="reg-item" v-for="src in mirrorSources" :key="src">
            <div class="reg-host mono">{{ src }}</div>
            <span class="chip" :class="isLoggedIn(src) ? 'ok' : 'gray'"><i class="dot"></i>{{ isLoggedIn(src) ? '已登录' : '未登录' }}</span>
            <button class="btn sm" v-if="!isLoggedIn(src)" @click="openLogin(hostOf(src))">登录</button>
            <button class="btn sm" v-else @click="doLogout(hostOf(src))">退出</button>
            <button class="btn sm danger" @click="removeMirrorSource(src)">删除</button>
          </div>
        </div>

        <!-- 添加镜像源 -->
        <div style="border-top:1px solid var(--border);padding-top:12px">
          <div style="font-weight:600;font-size:13px;margin-bottom:8px">添加镜像源</div>
          <div class="reg-grid">
            <label class="fld"><span>镜像源地址</span><input v-model="newMirrorUrl" placeholder="如 https://docker.1panel.live"></label>
            <label class="fld" v-if="showMirrorCreds"><span>用户名</span><input v-model="newMirrorUser" placeholder="仅私有源需要"></label>
            <label class="fld" v-if="showMirrorCreds"><span>密码 / Token</span><input type="password" v-model="newMirrorPass" placeholder="仅私有源需要"></label>
          </div>
          <div class="btn-row" style="margin-top:8px;flex-wrap:wrap">
            <button class="btn" v-if="!showMirrorCreds" @click="showMirrorCreds = true">+ 需要登录（填账号密码）</button>
            <button class="btn sm" v-else @click="showMirrorCreds = false">取消填账号</button>
            <button class="btn primary" :disabled="addMirrorLoading" @click="addMirrorSource">{{ addMirrorLoading ? '添加中…' : '添加镜像源' }}</button>
            <button class="btn sm" :disabled="diagMirrorLoading" @click="runDiagMirror">{{ diagMirrorLoading ? '诊断中…' : '连通性诊断' }}</button>
          </div>
          <div v-if="diagMirror" class="diag-box" style="margin-top:10px">
            <div class="diag-row"><span>Docker Hub 可达</span><span :class="(diagMirror.dockerHub||'').startsWith('OK') ? 'ok' : 'bad'">{{ diagMirror.dockerHub || '未知' }}</span></div>
            <div class="diag-row"><span>当前生效镜像源</span><span class="mono">{{ (diagMirror.infoMirrors || '[]') }}</span></div>
            <template v-for="(v, k) in (diagMirror.probe || {})" :key="k">
              <div class="diag-row"><span class="mono">{{ k }}</span><span :class="String(v).startsWith('OK') ? 'ok' : 'bad'">{{ v }}</span></div>
            </template>
            <div v-if="diagMirror.daemon" class="diag-raw">daemon.json:<br><span class="mono">{{ diagMirror.daemon }}</span></div>
          </div>
        </div>
      </div>

      <!-- 单源登录弹窗 -->
      <div v-if="showLogin" class="modal-mask" @click.self="closeLogin">
        <div class="modal">
          <header>登录镜像源 <span class="mono" style="font-weight:normal">{{ loginHost }}</span> <span class="x" @click="closeLogin">×</span></header>
          <div class="body">
            <p class="page-sub" style="margin-top:0">该镜像源需要鉴权，请填写账号密码以 docker login 方式登录（凭据由 Docker 写入 ~/.docker/config.json，本程序不持久化密码）。</p>
            <label class="fld"><span>用户名</span><input v-model="loginUser" placeholder="用户名 / 邮箱"></label>
            <label class="fld"><span>密码 / Token</span><input type="password" v-model="loginPass" placeholder="密码或访问令牌"></label>
          </div>
          <footer>
            <button class="btn" @click="closeLogin">取消</button>
            <button class="btn primary" :disabled="loginLoading" @click="doLogin">{{ loginLoading ? '登录中…' : '登录' }}</button>
          </footer>
        </div>
      </div>
    </div>
  </div>`,
};


// ---------------------------------------------------- Interactive Terminal (P1: WebSocket)
export const InteractiveTerminalView = {
  data() {
    return {
      termId: '', termName: '', out: '', input: '', ws: null, connected: false, busy: false,
    };
  },
  computed: {
    lines() { return (this.out || '').split('\n'); },
  },
  mounted() {
    const m = (location.hash || '').match(/term\/([^/?#]+)/);
    this.termId = m ? decodeURIComponent(m[1]) : '';
    if (!this.termId) { this.out = '缺少容器 ID'; return; }
    this.loadName();
    this.connect();
  },
  beforeUnmount() { this.disconnect(); },
  methods: {
    async loadName() {
      try { const c = await api.inspectContainer(this.termId); this.termName = (c && (c.Name || c.name) || '').replace(/^\//, ''); }
      catch (e) { this.termName = ''; }
    },
    connect() {
      this.disconnect();
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      let url;
      try { url = proto + '://' + location.host + '/ws/terminal/' + encodeURIComponent(this.termId); }
      catch (e) { this.out = (this.out ? this.out + '\n' : '') + '地址解析失败'; return; }
      try {
        const ws = new WebSocket(url);
        this.ws = ws;
        ws.onopen = () => { this.connected = true; this.out = (this.out ? this.out + '\n' : '') + '【已连接终端 ' + (this.termName || this.termId.slice(0,12)) + '】\n'; };
        ws.onmessage = (e) => { this.out = (this.out ? this.out + '' : '') + String(e.data); this.$nextTick(() => this.scrollBottom()); };
        ws.onclose = () => { this.connected = false; this.out = this.out + '\n【连接已关闭】\n'; };
        ws.onerror = () => { this.connected = false; this.out = this.out + '\n【连接出错】\n'; };
      } catch (e) { this.out = (this.out ? this.out + '\n' : '') + 'WebSocket 创建失败：' + e.message; }
    },
    disconnect() { if (this.ws) { try { this.ws.close(); } catch (e) {} this.ws = null; } this.connected = false; },
    send() {
      const v = this.input;
      if (!v) return;
      if (this.ws && this.connected) { try { this.ws.send(v + '\n'); } catch (e) { this.out = this.out + '\n发送失败：' + e.message; } }
      this.input = '';
    },
    scrollBottom() { const el = this.$refs.termOut; if (el) el.scrollTop = el.scrollHeight; },
    back() { if (this.$root && this.$root.nav) this.$root.nav('containers'); else location.hash = '#/containers'; },
  },
  template: `
  <div class="term-page">
    <div class="log-head">
      <div class="lh-left">
        <button class="btn sm" @click="back">‹ 返回容器</button>
        <div class="lh-title">交互式终端<template v-if="termName"> · <b>{{ termName }}</b></template></div>
        <span class="mono muted-sm">{{ termId }}</span>
        <span class="conn" :class="connected ? 'on' : 'off'">{{ connected ? '已连接' : '未连接' }}</span>
      </div>
      <div class="lh-right">
        <button class="btn sm" @click="connect" :disabled="connected">重新连接</button>
      </div>
    </div>
    <div class="term-body">
      <pre ref="termOut" class="term-pre">{{ out || '(等待输出…)' }}</pre>
      <div class="term-input">
        <span class="ps">$</span>
        <input v-model="input" @keyup.enter="send" placeholder="输入命令后回车（如 ls -la / ）" :disabled="!connected">
      </div>
    </div>
    <div class="log-foot muted-sm">通过 WebSocket 直连容器内的 Shell（/bin/sh）。命令输出实时回显。</div>
  </div>
  `,
};

// ---------------------------------------------------- Settings (P1.7: Docker 重启 + 主题)

// ---------------------------------------------------- Audit (P2.6: 操作审计)
export const AuditView = {
  data() {
    return { lines: [], filter: '', loading: false, err: '' };
  },
  mounted() { this.load(); },
  computed: {
    filtered() {
      const q = (this.filter || '').trim().toLowerCase();
      if (!q) return this.lines;
      return this.lines.filter((l) => l.toLowerCase().includes(q));
    },
    text() { return this.filtered.join('\n'); },
  },
  methods: {
    async load() {
      this.loading = true; this.err = '';
      try { this.lines = await api.listAudit(500); }
      catch (e) { this.err = e.message; }
      finally { this.loading = false; }
    },
    async exportLog() {
      try { await api.exportAudit(); }
      catch (e) { toast(e.message, 'err'); }
    },
  },
  template: `
  <div class="view">
    <div class="page-head">
      <div><h2 class="page-title" style="margin:0">审计日志</h2><p class="page-sub" style="margin:2px 0 0">记录关键操作（容器/镜像/卷/网络/用户等），仅管理员可见</p></div>
      <div class="btn-row"><input class="search" v-model="filter" placeholder="过滤审计内容…"><button class="btn" @click="exportLog">导出</button><button class="btn" @click="load">刷新</button></div>
    </div>
    <div v-if="err" class="empty">加载失败：{{ err }}</div>
    <div v-else-if="loading" class="center-pad"><span class="spinner"></span></div>
    <div v-else class="card tbl-wrap list-scroll">
      <pre class="audit-pre">{{ text || '(暂无记录)' }}</pre>
    </div>
  </div>
  `,
};

// ---------------------------------------------------- Setup (环境检测与安装向导)
export const SetupView = {
  data() {
    return {
      loading: false, err: '', report: null,
      // 安装进度
      installing: false, installMsg: '', task: null, poll: null, log: [], progress: 0,
      // 单独创建保活任务
      creatingKA: false,
      // 单独修复 .wslconfig（补写缺失项，保留既有配置）
      fixingWsl: false,
    };
  },
  mounted() { this.load(); },
  beforeUnmount() { if (this.poll) { clearInterval(this.poll); this.poll = null; } },
  computed: {
    missingCount() {
      if (!this.report || !this.report.components) return 0;
      return this.report.components.filter((c) => ['missing', 'outdated', 'misconfigured'].includes(c.status)).length;
    },
    canInstall() { return !!(this.$root.user && this.$root.user.isAdmin); },
  },
  methods: {
    async load() {
      this.loading = true; this.err = '';
      // 优先从后端缓存读取（后端启动已预热，几乎瞬时），首屏不再等待所有
      // wsl.exe / PowerShell 探测脚本跑完；随后在后台静默刷新一次保证数据最新，
      // 刷新结果回来再覆盖，不阻塞页面渲染。
      try { this.report = await api.getPrereqs(); }
      catch (e) { this.err = e.message; }
      finally { this.loading = false; }
      api.getPrereqs(true).then((r) => { if (r && !this.err) this.report = r; }).catch(() => {});
    },
    async recheck() {
      this.loading = true;
      try { this.report = await api.getPrereqs(true); }
      catch (e) { this.err = e.message; }
      finally { this.loading = false; }
    },
    statusText(s) {
      return { ok: '正常', missing: '缺失', outdated: '可更新', misconfigured: '配置缺失', unknown: '未知' }[s] || '未知';
    },
    statusClass(s) { return s || 'unknown'; },
    async createKeepAlive() {
      if (!this.canInstall) { toast('仅管理员可创建保活任务', 'err'); return; }
      this.creatingKA = true;
      try {
        const r = await api.createKeepAlive();
        toast((r && r.message) || '保活任务已创建', 'ok');
        this.load();
      } catch (e) {
        toast('创建失败：' + e.message, 'err');
      } finally {
        this.creatingKA = false;
      }
    },
    async fixWslConfig() {
      if (!this.canInstall) { toast('仅管理员可修改 .wslconfig', 'err'); return; }
      this.fixingWsl = true;
      try {
        const r = await api.setWslConfig({ systemd: true });
        if (!r || !r.ok) throw new Error((r && (r.error || r.message)) || '写入失败');
        toast('已为 .wslconfig 补写 systemd=true（保留 networkingMode 等既有配置）', 'ok');
        this.load();
      } catch (e) {
        toast('修复失败：' + e.message, 'err');
      } finally {
        this.fixingWsl = false;
      }
    },
    async install() {
      if (!this.canInstall) { toast('仅管理员可执行环境安装', 'err'); return; }
      if (!confirmDanger('确认安装并自动配置 Docker 运行环境？\n\n将检测并补齐：CPU 虚拟化功能、WSL2、' + 'Debian 发行版、Docker 引擎（含更新到最新版）、.wslconfig 与保活计划任务。\n\n' + '部分步骤（启用 Windows 功能 / 安装 WSL）可能需要重启电脑；安装脚本会以管理员权限运行（可能弹出 UAC，请点允许）。')) return;
      this.installing = true; this.installMsg = ''; this.log = []; this.progress = 0;
      try {
        const r = await api.installPrereqs();
        if (!r || !r.taskId) throw new Error('未返回任务 ID');
        this.pollTask(r.taskId);
      } catch (e) {
        this.installing = false;
        this.installMsg = '启动失败：' + e.message;
        toast('启动失败：' + e.message, 'err');
      }
    },
    pollTask(id) {
      if (this.poll) clearInterval(this.poll);
      const tick = async () => {
        try {
          const t = await api.getTask(id);
          if (!t) return;
          if (typeof t.progress === 'number') this.progress = t.progress;
          if (Array.isArray(t.log)) this.log = t.log.map((l) => ({ t: l.t, msg: l.msg, level: l.level }));
          if (t.status !== 'running') {
            if (this.poll) { clearInterval(this.poll); this.poll = null; }
            this.installing = false;
            if (t.status === 'success') {
              this.installMsg = (t.result && t.result.message) || '安装完成';
              toast('环境安装与配置完成', 'ok');
              this.load();
            } else {
              const msg = (t.error && (t.error.message || t.error)) || '安装失败';
              this.installMsg = '失败：' + msg;
              toast('安装失败：' + msg, 'err');
            }
          }
        } catch (_) { /* keep polling */ }
      };
      this.poll = setInterval(tick, 1500);
      tick();
    },
  },
  template: `
  <div class="view">
    <div class="page-head">
      <div>
        <h2 class="page-title" style="margin:0">环境检测与安装</h2>
        <p class="page-sub" style="margin:2px 0 0">检测虚拟化 / WSL / Debian / Docker 与必要配置；缺失时一键安装并自动配置</p>
      </div>
      <div class="btn-row">
        <button class="btn" :disabled="loading || installing" @click="recheck">重新检测</button>
      </div>
    </div>

    <div v-if="err" class="empty">检测失败：{{ err }}<br><button class="btn sm" @click="load">重试</button></div>
    <div v-else-if="loading" class="center-pad"><span class="spinner"></span></div>

    <template v-else-if="report">
      <!-- 权限状态：区分“项目管理员(登录角色)”与“Windows 主机管理员(进程权限)” -->
      <div v-if="report.windowsAdmin" class="banner ok">
        <b>后端正以 Windows 主机管理员身份运行</b>：创建保活任务 / 一键安装可直接执行，无需再弹 UAC。
      </div>
      <div v-else class="banner err">
        <b>⚠ 后端当前是普通用户（不是 Windows 主机管理员）</b>。创建保活任务 / 一键安装需要<strong>宿主机管理员</strong>权限，而“项目管理员”登录角色 ≠ Windows 主机管理员。
        <br>解决：<strong>右键 RunAsAdmin.bat（或 restart-backend.ps1）→ “以管理员身份运行”</strong>，在 UAC 弹窗点“是”，然后点上方“重新检测”。
      </div>

      <!-- 总览横幅 -->
      <div v-if="report.allOk" class="banner ok">
        <b>环境已就绪</b>：虚拟化、WSL、Debian、Docker 与必要配置均已安装并正确设置。
      </div>
      <div v-else class="banner warn">
        <b>发现 {{ missingCount }} 项需要安装/配置</b>。可点击下方“一键安装并自动配置”，由本项目自动完成全部环境搭建。
      </div>

      <!-- 逐项清单 -->
      <div class="card list-scroll">
        <table class="tbl">
          <thead><tr><th style="width:34px"></th><th>检测项</th><th style="width:90px">状态</th><th>详情</th><th>修复建议</th></tr></thead>
          <tbody>
            <tr v-for="c in report.components" :key="c.key" :class="'row-' + statusClass(c.status)">
              <td><span class="prereq-dot" :class="statusClass(c.status)"></span></td>
              <td>{{ c.label }}</td>
              <td><span class="prereq-tag" :class="statusClass(c.status)">{{ statusText(c.status) }}</span></td>
              <td class="muted-sm">{{ c.detail || '-' }}</td>
              <td class="muted-sm">
                <span v-if="['missing','outdated','misconfigured'].includes(c.status)">{{ c.fix || '运行一键安装向导' }}</span>
                <span v-else>-</span>
                <button v-if="c.key === 'keepalive' && c.status === 'missing' && canInstall" class="btn sm" :disabled="creatingKA" @click="createKeepAlive" style="margin-left:8px">{{ creatingKA ? '创建中…' : '创建保活任务' }}</button>
                <span v-if="c.key === 'keepalive' && c.status === 'missing' && canInstall && !report.windowsAdmin" style="margin-left:8px;color:#e5484d">将弹出 UAC 提权窗口，点“是”即创建（无需重启后端）</span>
                <button v-if="c.key === 'wslconfig' && (c.status === 'missing' || c.status === 'misconfigured') && canInstall" class="btn sm" :disabled="fixingWsl" @click="fixWslConfig" style="margin-left:8px">{{ fixingWsl ? '修复中…' : '修复 .wslconfig' }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 安装控制 -->
      <div class="card" style="margin-top:16px">
        <div class="toolbar"><b>一键安装并自动配置</b></div>
        <p class="muted-sm">将以管理员权限运行安装向导，依次启用虚拟化功能、安装 WSL2 与 Debian、安装并升级 Docker 引擎、写入 .wslconfig、创建自启与保活计划任务。安装过程中窗口可能弹出 UAC 提权请求。</p>
        <button class="btn primary" :disabled="installing || !canInstall" @click="install">
          {{ installing ? '安装中…' : '一键安装并自动配置' }}
        </button>
        <p v-if="!canInstall" class="muted-sm" style="margin-top:8px;color:#e5484d">仅项目管理员可执行环境安装。</p>
        <p v-else-if="!report.windowsAdmin" class="muted-sm" style="margin-top:8px;color:#e5484d">当前后端不是 Windows 主机管理员，安装将尝试弹 UAC 提权；若弹窗未出现，请右键 RunAsAdmin.bat 以管理员身份重启后端后再试。</p>

        <div v-if="installing || log.length" style="margin-top:14px">
          <div class="upd-progress"><div class="upd-bar-fill" :style="{ width: (progress||0) + '%' }"></div></div>
          <div class="muted-sm" style="margin:6px 0">{{ progress || 0 }}% · {{ installMsg || '正在安装…' }}</div>
          <pre class="prereq-log">{{ log.map(l => l.msg).join('\\n') }}</pre>
        </div>
      </div>
    </template>

    <div v-else class="empty">无可显示的环境信息。</div>
  </div>
  `,
};

