// Simple append-only file logger. Writes to the configured log file.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const LOG_FILE = cfg.logFileAbs;

function ensureDir() {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  } catch (e) {
    // ignore - root dir exists
  }
}

function write(level, msg) {
  ensureDir();
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) {
    // last-resort: console
    console.log(line.trim());
  }
}

module.exports = {
  info: (m) => write('INFO', m),
  warn: (m) => write('WARN', m),
  error: (m) => write('ERROR', m),
  raw: write,
};
