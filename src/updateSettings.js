// Update-scan settings: how often to auto-check image updates and whether to
// auto-apply them. Persisted as JSON under the data dir so it survives restarts.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const FILE = path.join(cfg.dataDirAbs || path.join(__dirname, '..', 'data'), 'update-settings.json');

const DEFAULTS = {
  // 扫描更新频率（分钟）。0 = 关闭自动扫描。
  scanIntervalMinutes: 360,
  // 检测到可更新后，是否自动拉取最新镜像并按原配置重建容器。
  autoUpdateEnabled: false,
  // 自动更新范围：'running' = 仅运行中容器；'all' = 全部容器（含已停止）。
  autoUpdateScope: 'running',
};

function readSettings() {
  try {
    if (!fs.existsSync(FILE)) return { ...DEFAULTS };
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { ...DEFAULTS, ...d };
  } catch (e) {
    return { ...DEFAULTS };
  }
}

function writeSettings(obj) {
  const merged = { ...DEFAULTS, ...(obj || {}) };
  // coerce types defensively
  merged.scanIntervalMinutes = Math.max(0, Number(merged.scanIntervalMinutes) || 0);
  merged.autoUpdateEnabled = !!merged.autoUpdateEnabled;
  merged.autoUpdateScope = merged.autoUpdateScope === 'all' ? 'all' : 'running';
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(merged, null, 2), 'utf8');
  } catch (e) {
    // non-fatal: in-memory value still returned
  }
  return merged;
}

module.exports = { readSettings, writeSettings, DEFAULTS };
