// Frontend background-task dock: polls /api/tasks, shows a live panel with
// progress + logs, and exposes whenTaskDone() so views can refresh their lists
// once an operation finishes.
import { api } from './api.js';
import { notify } from './ui.js';

const TYPE_LABEL = {
  'image.pull': '拉取镜像',
  'image.remove': '删除镜像',
  'image.prune': '清理悬空镜像',
  'image.tag': '标记镜像',
  'image.push': '推送镜像',
  'container.create': '创建容器',
  'container.start': '启动容器',
  'container.stop': '停止容器',
  'container.restart': '重启容器',
  'container.kill': '强杀容器',
  'container.pause': '暂停容器',
  'container.unpause': '恢复容器',
  'container.remove': '删除容器',
  'container.recreate': '重构（重建）容器',
  'container.update': '更新镜像重建容器',
  'volume.remove': '删除卷',
  'volume.create': '新建卷',
  'volume.prune': '清理卷',
  'network.remove': '删除网络',
  'network.create': '新建网络',
  'network.prune': '清理网络',
};

// App-wide reactive store for background tasks, shared between the TaskDock
// (which polls + writes it) and the App shell (which reads the running count
// for the top-right red-dot badge). Using a single reactive object avoids two
// independent polls and keeps the badge in sync with the dock.
export const taskStore = Vue.reactive({ tasks: [] });

// Poll a single task until it leaves the "running" state, then invoke cb(task).
export function whenTaskDone(taskId, cb, timeoutMs = 180000) {
  const start = Date.now();
  const check = async () => {
    try {
      const t = await api.getTask(taskId);
      if (t && t.status !== 'running') { try { cb(t); } catch (_) {} return; }
    } catch (e) { /* transient; keep polling */ }
    if (Date.now() - start > timeoutMs) return;
    setTimeout(check, 1000);
  };
  check();
}

export const TaskDock = {
  data() {
    return { tasks: [], open: false, prev: {} };
  },
  mounted() {
    this.timer = setInterval(() => this.refresh(), 1500);
    this.refresh();
    document.addEventListener('click', this.onDocClick, false);
  },
  beforeUnmount() {
    if (this.timer) clearInterval(this.timer);
    document.removeEventListener('click', this.onDocClick, false);
  },
  computed: {
    running() { return this.tasks.filter((t) => t.status === 'running').length; },
  },
  methods: {
    async refresh() {
      try {
        const r = await api.listTasks();
        const list = (r && r.tasks) || [];
        // 任务状态转变检测：运行 -> 成功/失败 时弹桌面通知
        for (const tk of list) {
          const before = this.prev[tk.id];
          if (before === 'running' && tk.status === 'success') notify('任务完成', (TYPE_LABEL[tk.type] || '任务') + '：成功');
          else if (before === 'running' && tk.status === 'error') notify('任务失败', (TYPE_LABEL[tk.type] || '任务') + '：' + (tk.message || '执行出错'));
          this.prev[tk.id] = tk.status;
        }
        this.tasks = list;
        taskStore.tasks = this.tasks; // keep app-wide store in sync
      } catch (e) {}
    },
    badge(t) { return t.status === 'success' ? 'ok' : t.status === 'error' ? 'err' : 'run'; },
    statusText(t) { return t.status === 'running' ? '运行中' : t.status === 'success' ? '成功' : '失败'; },
    typeLabel(t) { return TYPE_LABEL[t.type] || t.type || '任务'; },
    toggle() { this.open = !this.open; },
    close() { this.open = false; },
    onDocClick(e) {
      if (!this.open) return;
      const el = e.target;
      if (el && (el.closest && (el.closest('.task-fab') || el.closest('.task-pop')))) return;
      this.open = false;
    },
    goTasks() { location.hash = '#/tasks'; },
  },
  template: `
  <button class="task-fab" :class="{ active: running>0 }" @click="toggle"
          :title="running>0 ? ('后台任务（'+running+' 个进行中）') : '后台任务'">
    <span class="tf-ico">⏳</span>
    <span class="tf-badge" v-if="running">{{ running }}</span>
  </button>
  <div class="task-pop" v-if="open">
    <div class="tp-head">
      <span class="tp-title">后台任务</span>
      <span class="tp-running" v-if="running">{{ running }} 进行中</span>
      <span class="tp-close" @click.stop="close" title="关闭">✕</span>
    </div>
    <div class="tp-list">
      <div v-if="!tasks.length" class="tp-empty">暂无后台任务</div>
      <div v-for="t in tasks" :key="t.id" class="tp-item">
        <div class="tp-row">
          <span class="tp-name">{{ typeLabel(t) }}</span>
          <span class="tp-status" :class="badge(t)">{{ statusText(t) }}</span>
        </div>
        <div class="tp-bar" v-if="t.progress != null"><div class="tp-bar-fill" :style="{ width: (t.progress||0) + '%' }"></div></div>
        <div class="tp-msg" v-if="t.message">{{ t.message }}</div>
      </div>
    </div>
    <div class="tp-foot"><button class="tp-btn" @click="goTasks">查看全部任务</button></div>
  </div>
  `,
};
