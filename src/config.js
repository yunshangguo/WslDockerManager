// Central config loader. Resolves data paths to absolute (project-root relative)
// so the server works regardless of the current working directory.
//
// Desktop (Electron) mode sets two env vars so the packaged app keeps its
// mutable data in a writable, persistent place (%APPDATA%/WslDockerManager):
//   WSLDM_DATA_DIR  -> override the data directory (absolute path)
//   WSLDM_PORT      -> override the HTTP port
// When these are absent (plain `npm start`), behavior is unchanged.
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const ROOT = path.join(__dirname, '..');

function abs(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

cfg.rootDir = ROOT;

const DATA_DIR_OVERRIDE = process.env.WSLDM_DATA_DIR;
if (DATA_DIR_OVERRIDE) {
  const d = abs(DATA_DIR_OVERRIDE);
  cfg.dataDirAbs = d;
  cfg.secretsDirAbs = path.join(d, 'secrets');
  cfg.composeDirAbs = path.join(d, 'compose');
  cfg.composeBackupsDirAbs = path.join(d, 'compose', 'backups');
  cfg.auditLogFile = path.join(d, 'audit.log');
  cfg.logFileAbs = path.join(d, 'wsl-docker.log');
} else {
  cfg.dataDirAbs = abs(cfg.dataDir);
  cfg.secretsDirAbs = abs(cfg.secretsDir);
  cfg.composeDirAbs = abs(cfg.composeDir);
  cfg.composeBackupsDirAbs = abs(cfg.composeBackupsDir);
  cfg.auditLogFile = abs(cfg.auditLog);
  cfg.logFileAbs = abs(cfg.logFile);
}

cfg.usersFile = path.join(cfg.secretsDirAbs, 'users.json');

const PORT_OVERRIDE = Number(process.env.WSLDM_PORT);
if (Number.isInteger(PORT_OVERRIDE) && PORT_OVERRIDE > 0 && PORT_OVERRIDE < 65536) {
  cfg.port = PORT_OVERRIDE;
}

// session secret: prefer env, else config (warn-worthy but functional for local use)
cfg.session.secret = process.env.SESSION_SECRET || cfg.session.secret;

module.exports = cfg;
