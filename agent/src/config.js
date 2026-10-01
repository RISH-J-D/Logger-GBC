// Resolves agent configuration from (highest priority first):
//   1. environment variables  (DEVICE_LOGGER_SERVER, DEVICE_LOGGER_IDLE, ...)
//   2. a writable config.json in the app's userData dir (edited at runtime)
//   3. the config.json shipped with the install (resources/config.json)
//   4. built-in defaults
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  serverUrl: 'http://localhost:4000',
  idleTimeoutSeconds: 300,   // 5 minutes
  heartbeatSeconds: 30,
  pollSeconds: 5,
  agentKey: '',
};

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function load(app) {
  const userFile = path.join(app.getPath('userData'), 'config.json');
  // packaged resources/config.json, or ./config.json when running unpacked
  const resourceFile = process.resourcesPath
    ? path.join(process.resourcesPath, 'config.json')
    : path.join(__dirname, '..', 'config.json');

  const cfg = {
    ...DEFAULTS,
    ...readJson(resourceFile),
    ...readJson(userFile),
  };

  if (process.env.DEVICE_LOGGER_SERVER) cfg.serverUrl = process.env.DEVICE_LOGGER_SERVER;
  if (process.env.DEVICE_LOGGER_IDLE) cfg.idleTimeoutSeconds = Number(process.env.DEVICE_LOGGER_IDLE);
  if (process.env.DEVICE_LOGGER_KEY) cfg.agentKey = process.env.DEVICE_LOGGER_KEY;

  cfg.userFile = userFile;
  return cfg;
}

// Persist a runtime change (e.g. server URL entered on the login screen).
function save(app, patch) {
  const userFile = path.join(app.getPath('userData'), 'config.json');
  const current = readJson(userFile);
  const next = { ...current, ...patch };
  fs.writeFileSync(userFile, JSON.stringify(next, null, 2));
  return next;
}

module.exports = { load, save, DEFAULTS };
