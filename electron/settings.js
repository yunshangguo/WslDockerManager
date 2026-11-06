// Settings window renderer. Talks to the main process through the preload bridge
// (window.electronAPI), validates the form, and shows the save result.
(function () {
  const $ = (id) => document.getElementById(id);
  const portEl = $('port');
  const userEl = $('username');
  const pwEl = $('password');
  const pw2El = $('password2');
  const statusEl = $('status');
  const bannerEl = $('banner');
  const saveBtn = $('saveBtn');
  const closeBtn = $('closeBtn');

  let firstRun = false;
  let hasAdmin = false;

  function setStatus(text, kind) {
    statusEl.textContent = text || '';
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  async function load() {
    try {
      const s = await window.electronAPI.getSettings();
      firstRun = !!s.firstRun;
      hasAdmin = !!s.hasAdmin;
      if (s.port) portEl.value = s.port;
      if (s.username) userEl.value = s.username;
      if (firstRun) {
        bannerEl.classList.add('show');
        pwEl.placeholder = '设置管理员密码（必填）';
      } else if (hasAdmin) {
        userEl.placeholder = s.username || 'admin';
      }
    } catch (e) {
      setStatus('读取当前设置失败：' + e.message, 'err');
    }
  }

  function validate() {
    const port = Number(portEl.value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setStatus('端口必须是 1–65535 之间的整数', 'err');
      return null;
    }
    const username = (userEl.value || '').trim();
    if (!username || !/^[a-zA-Z0-9_.-]+$/.test(username)) {
      setStatus('账户名只能包含字母、数字、下划线、点、连字符', 'err');
      return null;
    }
    const password = pwEl.value || '';
    const password2 = pw2El.value || '';
    if (firstRun && !password) {
      setStatus('首次设置必须填写密码', 'err');
      return null;
    }
    if (password) {
      if (password.length < 4) { setStatus('密码至少 4 个字符', 'err'); return null; }
      if (password !== password2) { setStatus('两次输入的密码不一致', 'err'); return null; }
    }
    return { port, username, password: password || undefined };
  }

  async function save() {
    const payload = validate();
    if (!payload) return;
    saveBtn.disabled = true;
    setStatus('保存中…', '');
    try {
      const r = await window.electronAPI.saveSettings(payload);
      if (!r || !r.ok) {
        setStatus('保存失败：' + (r && r.error ? r.error : '未知错误'), 'err');
        saveBtn.disabled = false;
        return;
      }
      if (r.started) {
        setStatus('已保存，正在启动后端…', 'ok');   // main process closes this window
      } else if (r.restarted) {
        setStatus('已保存，后端已按新端口重启，主界面即将刷新', 'ok');
        saveBtn.disabled = false;
        setTimeout(() => { try { window.close(); } catch (_) {} }, 900);
      } else {
        setStatus('已保存', 'ok');
        saveBtn.disabled = false;
      }
    } catch (e) {
      setStatus('保存失败：' + e.message, 'err');
      saveBtn.disabled = false;
    }
  }

  saveBtn.addEventListener('click', save);
  closeBtn.addEventListener('click', () => { try { window.close(); } catch (_) {} });
  $('form').addEventListener('submit', (e) => { e.preventDefault(); save(); });

  load();
})();
