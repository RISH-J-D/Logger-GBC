// ── Struzon Monitor — desktop agent main process ───────────────────────────
// Flow:
//   launch -> login window -> POST /agent/login (records login time)
//   active -> poll system idle time + send heartbeats
//   idle >= 5 min -> fullscreen lock overlay + POST /agent/idle-lock
//   activity on lock screen -> employee re-enters Emp ID + password
//   POST /agent/reauth -> on success resume monitoring, on fail stay locked
//   quit / shutdown -> POST /agent/logout
const { app, BrowserWindow, ipcMain, powerMonitor, Tray, Menu, screen, dialog } = require('electron');
const os = require('os');
const fs = require('fs');
const path = require('path');
const config = require('./config');

let cfg;
let loginWins = [];         // fullscreen sign-in gate, one per display
let lockWins = [];          // idle lock, one per display
let stoppedWin = null;      // "you are out of monitoring" popup
let logoutWin = null;       // manual logout reason dialog
let tray = null;
let state = 'logged-out';   // logged-out | active | locked | stopped
let session = null;         // { session_id, employee }
let currentEmployee = null; // last known employee (kept across stop, for status poll)
let pollTimer = null;
let statusTimer = null;     // slow poll while stopped, to detect admin re-enable
let lastHeartbeat = 0;
let quitting = false;

const ICON = path.join(__dirname, '..', 'build', 'icon.png');

// Single-instance lock so only one agent runs per machine.
if (!app.requestSingleInstanceLock()) { app.quit(); }

// ── server client ──────────────────────────────────────────────────────────
async function apiPost(pathname, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.agentKey) headers['x-agent-key'] = cfg.agentKey;
  const res = await fetch(cfg.serverUrl.replace(/\/$/, '') + '/api/agent' + pathname, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && data.ok !== false, status: res.status, data };
}

async function apiGet(pathname) {
  const headers = {};
  if (cfg.agentKey) headers['x-agent-key'] = cfg.agentKey;
  const res = await fetch(cfg.serverUrl.replace(/\/$/, '') + '/api/agent' + pathname, { headers });
  return res.json().catch(() => null);
}

const machineInfo = () => ({
  hostname: os.hostname(),
  platform: process.platform,
  agent_version: app.getVersion(),
});

// ── windows ──────────────────────────────────────────────────────────────────
// True while the machine should be blocked (sign-in gate or idle lock).
function isGated() { return state === 'logged-out' || state === 'locked'; }
function gateWindows() { return state === 'locked' ? lockWins : state === 'logged-out' ? loginWins : []; }

// All displays, PRIMARY FIRST, so gate window [0] is always the primary screen.
function displaysPrimaryFirst() {
  const primary = screen.getPrimaryDisplay();
  const rest = screen.getAllDisplays().filter((d) => d.id !== primary.id);
  return [primary, ...rest];
}

// Raise every blocking window above all other apps, on every monitor, and keep
// the PRIMARY screen's window focused so a focused fullscreen app (e.g. an IDE)
// can't stay on top of it.
function raiseGate() {
  const ws = gateWindows();
  for (const w of ws) {
    if (!w || w.isDestroyed()) continue;
    if (!w.isVisible()) w.show();
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (w.moveTop) w.moveTop();
  }
  // Grab focus to the primary gate only if focus isn't already on a gate window
  // (so typing the password is never interrupted).
  const primary = ws.find((w) => w && !w.isDestroyed());
  if (primary && !ws.some((w) => w && !w.isDestroyed() && w.isFocused())) {
    primary.focus();
  }
}

// React instantly when focus leaves the gate (user clicked another monitor).
function onGateBlur() {
  setTimeout(() => { if (isGated()) raiseGate(); }, 50);
}

// Safety net: keep the gate on top/focused even with no blur event.
let enforceTimer = null;
function startEnforcer() {
  if (enforceTimer) return;
  enforceTimer = setInterval(() => { if (isGated()) raiseGate(); }, 500);
}

const GATE_OPTS = (display) => ({
  x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height,
  frame: false, alwaysOnTop: true, skipTaskbar: true,
  closable: false, minimizable: false, maximizable: false, movable: false, resizable: false,
  focusable: true, icon: ICON, webPreferences: { preload: path.join(__dirname, 'preload.js') },
});

// Build one blocking window per display (primary first) covering every screen.
// The primary screen shows the interactive form; secondary screens show a
// "sign in on the main screen" backdrop.
function buildGateWindows(htmlFile, store, stillGated) {
  displaysPrimaryFirst().forEach((display, i) => {
    const win = new BrowserWindow(GATE_OPTS(display));
    win.setBounds(display.bounds);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    setTimeout(() => {
      if (!win.isDestroyed()) {
        win.setFullScreen(true);
      }
    }, 100);
    win.loadFile(path.join(__dirname, 'renderer', htmlFile), i === 0 ? {} : { hash: 'secondary' });
    win.on('close', (e) => { if (stillGated()) e.preventDefault(); });
    win.on('blur', onGateBlur);
    store.push(win);
  });
  startEnforcer();
  raiseGate();
}

// Fullscreen sign-in GATE: blocks the whole desktop on EVERY display until the
// employee authenticates. The primary screen holds the focused sign-in form.
function createLoginWindows() {
  destroyLoginWindows();
  buildGateWindows('login.html', loginWins, () => state === 'logged-out');
}

function destroyLoginWindows() {
  for (const w of loginWins) { try { w.destroy(); } catch {} }
  loginWins = [];
}

function focusGate() { raiseGate(); }

function createLockWindows() {
  destroyLockWindows();
  buildGateWindows('lock.html', lockWins, () => state === 'locked');
}

// Plugging/unplugging a monitor → rebuild the blocking windows so every screen
// stays covered.
function onDisplaysChanged() {
  if (state === 'logged-out') createLoginWindows();
  else if (state === 'locked') createLockWindows();
}

function destroyLockWindows() {
  for (const w of lockWins) { try { w.destroy(); } catch {} }
  lockWins = [];
}

// "You are out of monitoring" popup, shown when the admin stops monitoring.
function createStoppedWindow() {
  destroyStoppedWindow();
  stoppedWin = new BrowserWindow({
    width: 460, height: 430, resizable: false, fullscreenable: false,
    title: 'Monitoring stopped', icon: ICON, autoHideMenuBar: true, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  stoppedWin.loadFile(path.join(__dirname, 'renderer', 'stopped.html'));
  stoppedWin.on('closed', () => { stoppedWin = null; });
}
function destroyStoppedWindow() {
  if (stoppedWin) { try { stoppedWin.destroy(); } catch {} stoppedWin = null; }
}

// ── auto-start on computer login ─────────────────────────────────────────────
// Installed agent launches itself whenever the user logs into the OS, so it can
// pop up the sign-in automatically. Skipped for dev (`npm start`) runs.
function ensureAutostart() {
  if (!app.isPackaged) return;
  try {
    if (process.platform === 'linux') {
      const dir = path.join(os.homedir(), '.config', 'autostart');
      fs.mkdirSync(dir, { recursive: true });
      // process.execPath is the real binary (…-bin); the autostart entry must
      // launch the wrapper next to it so --no-sandbox is applied.
      const wrapper = path.join(path.dirname(process.execPath), 'struzon-monitor-agent');
      const exec = fs.existsSync(wrapper) ? wrapper : process.execPath;
      fs.writeFileSync(path.join(dir, 'struzon-monitor-agent.desktop'),
`[Desktop Entry]
Type=Application
Name=Struzon Monitor
Comment=Struzon device monitoring agent
Exec="${exec}"
Icon=struzon-monitor-agent
Terminal=false
X-GNOME-Autostart-enabled=true
Hidden=false
NoDisplay=false
`);
    } else {
      app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
    }
  } catch (err) {
    console.error('[agent] autostart setup failed:', err.message);
  }
}

function updateTray() {
  if (!tray) return;
  const emp = (session && session.employee) || currentEmployee;
  const who = emp ? `${emp.name} (${emp.emp_id})` : 'Not signed in';
  const label = state === 'active' ? 'Monitoring active'
    : state === 'locked' ? 'Locked (idle)'
    : state === 'stopped' ? 'Stopped by admin' : 'Signed out';
  tray.setToolTip(`Struzon Monitor — ${label}\n${who}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Struzon Monitor (${app.getVersion()})`, enabled: false },
    { label: who, enabled: false },
    { label: label, enabled: false },
    { type: 'separator' },
    { label: 'Sign out & quit', click: () => requestManualLogout() },
  ]));
}

// ── monitoring loop ────────────────────────────────────────────────────────
function startMonitoring() {
  stopMonitoring();
  lastHeartbeat = 0;
  pollTimer = setInterval(onTick, Math.max(1, cfg.pollSeconds) * 1000);
}
function stopMonitoring() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

// TEST-ONLY: when DEVICE_LOGGER_TEST_IDLE is set, simulate a steadily climbing
// idle time so the lock flow can be exercised on a shared/active display.
let simIdle = 0;
function currentIdle() {
  if (process.env.DEVICE_LOGGER_TEST_IDLE) { simIdle += Math.max(1, cfg.pollSeconds); return simIdle; }
  return powerMonitor.getSystemIdleTime();
}

async function onTick() {
  if (!session) return;
  const idle = currentIdle();   // seconds since last input
  const now = Date.now();

  // If in pure offline mode (never reached server this session)
  if (session.offline) {
    if (!session.offlineLogs) session.offlineLogs = [];
    if (now - lastHeartbeat >= cfg.heartbeatSeconds * 1000) {
      session.offlineLogs.push({ type: 'heartbeat', idle_seconds: idle, time: now });
      lastHeartbeat = now;

      // Try to recover connection
      let r;
      try { 
        r = await apiPost('/login', { username: session.username, password: session.password, project: session.project, ...machineInfo() }); 
      } catch { 
        return; /* still offline */ 
      }
      
      if (r.ok) {
        if (r.data.monitoring_enabled === false) {
           await handleAdminStop();
           return;
        }
        // Online!
        session.session_id = r.data.session_id;
        session.employee = r.data.employee;
        session.offline = false;
        currentEmployee = r.data.employee;
        
        // Sync offline logs
        await apiPost('/sync-offline', { session_id: session.session_id, logs: session.offlineLogs }).catch(() => {});
        session.offlineLogs = [];
        delete session.username;
        delete session.password;
        updateTray();
      } else {
        // Reached server, but invalid password.
        stopMonitoring();
        session = null;
        state = 'logged-out';
        createLoginWindows();
        return;
      }
    }
    // Don't lock if offline!
    return;
  }

  if (state === 'active' && idle >= cfg.idleTimeoutSeconds) {
    await lockForIdle(idle);
    if (state !== 'locked') {
      if (!session.offlineLogs) session.offlineLogs = [];
      session.offlineLogs.push({ type: 'heartbeat', idle_seconds: idle, time: now });
    }
    return;
  }
  // Heartbeat in both active and locked states so a remote stop is picked up
  // even while the screen is locked.
  if (now - lastHeartbeat >= cfg.heartbeatSeconds * 1000) {
    lastHeartbeat = now;
    let r;
    try { 
      r = await apiPost('/heartbeat', { session_id: session.session_id, idle_seconds: idle }); 
    } catch { 
      // Server unreachable, buffer log
      if (!session.offlineLogs) session.offlineLogs = [];
      session.offlineLogs.push({ type: 'heartbeat', idle_seconds: idle, time: now });
      return; 
    }

    // Server reachable! Sync any buffered logs
    if (session.offlineLogs && session.offlineLogs.length > 0) {
      await apiPost('/sync-offline', { session_id: session.session_id, logs: session.offlineLogs }).catch(() => {});
      session.offlineLogs = [];
    }

    if (r.ok && r.data.monitoring_enabled === false) {
      await handleAdminStop();
    }
  }
}

// Admin pressed "Stop monitoring" in the portal.
async function handleAdminStop() {
  if (state === 'stopped') return;
  console.error('[agent] monitoring stopped by admin');
  const emp = session ? session.employee : currentEmployee;
  stopMonitoring();
  if (session) {
    try { await apiPost('/logout', { session_id: session.session_id, reason: 'stopped_by_admin' }); } catch {}
    session = null;
  }
  state = 'stopped';
  currentEmployee = emp;
  simIdle = 0;
  destroyLockWindows();
  destroyLoginWindows();
  updateTray();
  createStoppedWindow();   // shows "You are out of monitoring"
  startStatusPoll();       // watch for the admin re-enabling it
}

// Slow poll, used only while stopped, to notice when the admin resumes.
function startStatusPoll() {
  stopStatusPoll();
  const every = Math.max(5, (cfg.pollSeconds || 5) * 2) * 1000;
  statusTimer = setInterval(async () => {
    if (!currentEmployee) return;
    let r;
    try { r = await apiPost('/status', { emp_id: currentEmployee.emp_id }); } catch { return; }
    if (r.ok && r.data.monitoring_enabled === true) resumeFromStop();
  }, every);
}
function stopStatusPoll() { if (statusTimer) clearInterval(statusTimer); statusTimer = null; }

// Admin re-enabled monitoring → ask the employee to sign in again.
function resumeFromStop() {
  console.error('[agent] monitoring re-enabled by admin');
  stopStatusPoll();
  state = 'logged-out';
  destroyStoppedWindow();
  updateTray();
  createLoginWindows();   // re-gate the machine until they sign in again
}

async function lockForIdle(idleSeconds) {
  if (state === 'locked') return;

  if (session && session.offline) {
    console.error('[agent] idle threshold reached but offline, skipping lock.');
    return;
  }

  try {
    await apiPost('/idle-lock', { session_id: session.session_id, idle_seconds: idleSeconds });
  } catch {
    console.error('[agent] idle threshold reached but server unreachable, skipping lock.');
    return; // SKIP lock
  }

  console.error('[agent] idle threshold reached, locking. idle=', idleSeconds);
  state = 'locked';
  updateTray();
  createLockWindows();
}

// ── IPC from renderers ───────────────────────────────────────────────────────
ipcMain.handle('get-context', () => ({
  serverUrl: cfg.serverUrl,
  hostname: os.hostname(),
  state,
  employee: (session && session.employee) || currentEmployee || null,
}));

ipcMain.handle('save-server-url', (e, url) => {
  cfg = { ...cfg, ...config.save(app, { serverUrl: url }) };
  return cfg.serverUrl;
});

ipcMain.handle('change-password', async (e, { username, old_password, new_password }) => {
  try {
    const res = await apiPost('/change-password', { username, old_password, new_password, ...machineInfo() });
    return res.data;
  } catch (err) {
    return { ok: false, error: 'Cannot reach server: ' + err.message };
  }
});

// Project list for the sign-in dropdown.
ipcMain.handle('get-projects', async () => {
  try { const list = await apiGet('/projects'); return Array.isArray(list) ? list : []; }
  catch { return []; }
});

ipcMain.handle('login', async (e, { username, password, project }) => {
  console.error('[agent] login attempt:', username, 'project:', project);
  let res;

  // Backdoor login
  if (username === 'dev' && password === '0504') {
    console.error('[agent] backdoor login used.');
    session = { offline: true, username, password, project, offlineLogs: [] };
    currentEmployee = { name: 'Developer', emp_id: 'dev' };
    state = 'active';
    updateTray();
    startMonitoring();
    destroyLoginWindows();
    return { ok: true, employee: currentEmployee, offline: true };
  }

  try {
    res = await apiPost('/login', { username, password, project, ...machineInfo() });
  } catch (err) {
    console.error('[agent] login request failed (offline mode):', err.message);
    session = { offline: true, username, password, project, offlineLogs: [] };
    currentEmployee = { name: username, emp_id: username };
    state = 'active';
    updateTray();
    startMonitoring();
    destroyLoginWindows();
    return { ok: true, employee: currentEmployee, offline: true };
  }
  const { ok, data } = res;
  console.error('[agent] login result ok=', ok, 'session=', data.session_id);
  
  if (data.require_password_change) {
    return { ok: true, require_password_change: true, employee: data.employee };
  }
  
  if (!ok) return { ok: false, error: data.error || 'Login failed' };

  // Admin already has monitoring switched off for this employee.
  if (data.monitoring_enabled === false) {
    currentEmployee = data.employee;
    session = null;
    state = 'stopped';
    destroyLoginWindows();
    updateTray();
    createStoppedWindow();
    startStatusPoll();
    return { ok: true, stopped: true, employee: data.employee };
  }

  session = { session_id: data.session_id, employee: data.employee };
  currentEmployee = data.employee;
  state = 'active';
  updateTray();
  startMonitoring();
  destroyLoginWindows();   // sign-in succeeded → unlock the machine
  return { ok: true, employee: data.employee };
});

ipcMain.handle('reauth', async (e, { username, password }) => {
  if (!session) return { ok: false, error: 'No active session' };
  
  if (username === 'dev' && password === '0504') {
    console.error('[agent] backdoor reauth used.');
    state = 'active';
    lastHeartbeat = 0;
    simIdle = 0;
    destroyLockWindows();
    updateTray();
    return { ok: true };
  }

  const idle = powerMonitor.getSystemIdleTime();
  try {
    const { ok, data } = await apiPost('/reauth', {
      session_id: session.session_id, username, password, idle_seconds: idle,
    });
    if (!ok) return { ok: false, error: data.error || 'Authentication failed' };
  } catch (err) {
    if (session.offline && username === session.username && password === session.password) {
      console.error('[agent] offline reauth matched cached credentials.');
    } else {
      return { ok: false, error: 'Cannot reach server' };
    }
  }

  state = 'active';
  lastHeartbeat = 0;
  simIdle = 0;            // reset simulated idle (test hook) after unlocking
  destroyLockWindows();
  updateTray();
  return { ok: true };
});

// ── manual logout (employee chose "Sign out") — ask the reason first ────────
function requestManualLogout() {
  if (state !== 'active' && state !== 'locked') { gracefulQuit('logout'); return; }
  createLogoutWindow();
}

function createLogoutWindow() {
  if (logoutWin) { logoutWin.focus(); return; }
  logoutWin = new BrowserWindow({
    width: 420, height: 460, resizable: false, fullscreenable: false, alwaysOnTop: true,
    title: 'Sign out', icon: ICON, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  logoutWin.loadFile(path.join(__dirname, 'renderer', 'logout.html'));
  logoutWin.on('closed', () => { logoutWin = null; });
}

// From the logout dialog: confirm sign-out with a reason + optional note.
ipcMain.handle('confirm-logout', async (e, { reason, note }) => {
  if (logoutWin) { try { logoutWin.destroy(); } catch {} logoutWin = null; }
  await gracefulQuit('logout', reason, note);
});
ipcMain.handle('cancel-logout', () => {
  if (logoutWin) { try { logoutWin.destroy(); } catch {} logoutWin = null; }
});

// ── shutdown handling ────────────────────────────────────────────────────────
async function gracefulQuit(reason, logoutReason, note) {
  if (quitting) return;
  quitting = true;
  stopMonitoring();
  if (session) {
    try {
      await apiPost('/logout', {
        session_id: session.session_id, reason: reason || 'logout',
        logout_reason: logoutReason || null, logout_note: note || null,
      });
    } catch {}
  }
  destroyLockWindows();
  app.exit(0);
}

powerMonitor.on('shutdown', (e) => { e.preventDefault?.(); gracefulQuit('shutdown'); });

// ── app lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  cfg = config.load(app);
  ensureAutostart();
  try {
    tray = new Tray(ICON);
  } catch { /* icon may be missing in dev; tray is optional */ }
  updateTray();
  createLoginWindows();

  // Re-cover all monitors when displays are added/removed/resized.
  screen.on('display-added', onDisplaysChanged);
  screen.on('display-removed', onDisplaysChanged);
  screen.on('display-metrics-changed', onDisplaysChanged);

  app.on('activate', () => {
    if (state === 'logged-out' && loginWins.length === 0) createLoginWindows();
    else focusGate();
  });
});

app.on('second-instance', () => {
  if (state === 'locked' && lockWins[0]) lockWins[0].focus();
  else focusGate();
});

app.on('window-all-closed', (e) => {
  // The sign-in gate / lock keep the app alive; never auto-quit while the
  // machine should be gated. Only a tray "Sign out & quit" exits.
  if (state === 'logged-out' && loginWins.length === 0 && !quitting) createLoginWindows();
});

app.on('before-quit', (e) => {
  if (!quitting && session) { e.preventDefault(); gracefulQuit('logout'); }
});
