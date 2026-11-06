// Append-only audit log for sensitive/mutating operations (Phase 6 hardening baseline).
const fs = require('fs');
const cfg = require('./config');
const log = require('./logger');

function audit(username, action, detail) {
  const line = `${new Date().toISOString()} [AUDIT] user=${username || '?'} action=${action} ${detail || ''}\n`;
  try {
    fs.mkdirSync(require('path').dirname(cfg.auditLogFile), { recursive: true });
    fs.appendFileSync(cfg.auditLogFile, line);
    rotateAudit();
  } catch (e) {
    log.warn(`audit write failed: ${e.message}`);
  }
}

function readAudit(limit = 200) {
  return readAuditRaw().slice(-Math.max(1, limit));
}

// 读取完整审计日志（不分页），供搜索/导出使用。
function readAuditRaw() {
  try {
    if (!fs.existsSync(cfg.auditLogFile)) return [];
    return fs.readFileSync(cfg.auditLogFile, 'utf8').split('\n').filter(Boolean);
  } catch (e) {
    return [];
  }
}

// 写入后自动轮转：超过阈值时只保留最近 N 行，避免日志无限增长。
function rotateAudit(maxBytes = 2 * 1024 * 1024, keepLines = 5000) {
  try {
    if (!fs.existsSync(cfg.auditLogFile)) return;
    const stat = fs.statSync(cfg.auditLogFile);
    if (stat.size <= maxBytes) return;
    const lines = fs.readFileSync(cfg.auditLogFile, 'utf8').split('\n').filter(Boolean);
    const keep = lines.slice(-keepLines);
    fs.writeFileSync(cfg.auditLogFile, keep.join('\n') + '\n');
    log.warn('audit log rotated (kept last ' + keep.length + ' lines)');
  } catch (e) { /* best-effort */ }
}

module.exports = { audit, readAudit, readAuditRaw, rotateAudit };
