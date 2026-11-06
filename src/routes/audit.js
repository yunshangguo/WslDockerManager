// Read-only access to the append-only audit log (P2: 操作审计可见化).
// Supports full-text search (?q=) and a raw text export (/export).
const express = require('express');
const fs = require('fs');
const cfg = require('../config');
const { readAudit, readAuditRaw } = require('../audit');

const router = express.Router();

router.get('/', (req, res) => {
  const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit || '200', 10) || 200));
  let lines = readAuditRaw();
  const q = (req.query.q || '').trim().toLowerCase();
  if (q) lines = lines.filter((l) => l.toLowerCase().includes(q));
  res.json({ lines: lines.slice(-limit) });
});

// 导出完整审计日志为纯文本下载。
router.get('/export', (req, res) => {
  try {
    let content = '';
    if (fs.existsSync(cfg.auditLogFile)) content = fs.readFileSync(cfg.auditLogFile, 'utf8');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit.log"');
    res.send(content);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
