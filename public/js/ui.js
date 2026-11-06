// Small UI helpers: toast + confirm. No framework needed.
export function toast(msg, type = 'info') {
  let root = document.getElementById('toast-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'toast-root';
    document.body.appendChild(root);
  }
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  root.appendChild(t);
  setTimeout(() => {
    t.classList.add('hide');
    setTimeout(() => t.remove(), 320);
  }, 3200);
}

export function confirmDanger(message) {
  return window.confirm(message);
}

// P2: 桌面通知（Web Notifications）。权限需用户授权；授予后任务完成/失败弹系统提醒。
let _permAsked = false;
export async function notify(title, body) {
  try {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      new Notification(title, { body: body || '' });
    } else if (Notification.permission !== 'denied' && !_permAsked) {
      _permAsked = true;
      Notification.requestPermission().then((p) => { if (p === 'granted') new Notification(title, { body: body || '' }); }).catch(() => {});
    }
  } catch (_) {}
}

// Format bytes to human readable
export function fmtBytes(n) {
  if (n == null || isNaN(n)) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i];
}

export function fmtPct(n) {
  if (n == null || isNaN(n)) return '-';
  return (n * 100).toFixed(1) + '%';
}
