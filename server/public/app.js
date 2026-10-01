// ── Struzon Admin Monitoring Portal ────────────────────────────────────────
const API = '/api/admin';
let token = localStorage.getItem('dl_token') || '';
let selectedEmp = null;             // currently selected employee row
let calMonth = startOfMonth(new Date());
let selectedDay = '';               // YYYY-MM-DD filter from calendar click

// ── tiny helpers ────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function fmtDateTime(s) { return s ? new Date(s).toLocaleString() : '—'; }
function fmtTime(s) { return s ? new Date(s).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '—'; }
function fmtDur(sec) {
  if (sec == null) return '—';
  sec = Math.max(0, sec); const h = Math.floor(sec/3600), m = Math.floor(sec%3600/60), s = sec%60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers||{}) },
  });
  if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
  if (!res.ok) throw new Error((await res.json().catch(()=>({}))).error || res.statusText);
  return res.json();
}

// ── auth ────────────────────────────────────────────────────────────────────
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  try {
    const r = await fetch(API + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('login-user').value, password: $('login-pass').value }) });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'Login failed');
    token = d.token; localStorage.setItem('dl_token', token);
    enterApp();
  } catch (err) { $('login-error').textContent = err.message; }
});
$('logout-btn').addEventListener('click', logout);
function logout() { token = ''; localStorage.removeItem('dl_token'); $('app-view').classList.add('hidden'); $('login-view').classList.remove('hidden'); }

function enterApp() {
  $('login-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  $('who').textContent = 'Signed in as admin';
  loadStats();
  loadEmployees('');
}

// ── stats ────────────────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const s = await api('/stats');
    $('stats').innerHTML = '';
    const cards = [
      ['Employees', s.employees, 'accent'],
      ['Active now', s.activeSessions, 'green'],
      ['Logins today', s.loginsToday, ''],
      ['Locked (idle)', s.lockedNow, 'yellow'],
    ];
    for (const [l, n, c] of cards) {
      const card = el('div', 'stat ' + c);
      card.append(el('div', 'n', String(n)), el('div', 'l', l));
      $('stats').append(card);
    }
  } catch {}
}

// ── employee directory ────────────────────────────────────────────────────────
async function loadEmployees(search) {
  const list = $('emp-list');
  list.innerHTML = '<div class="emp-item muted">Loading…</div>';
  try {
    const emps = await api('/employees?search=' + encodeURIComponent(search));
    list.innerHTML = '';
    if (!emps.length) { list.innerHTML = '<div class="emp-item muted">No employees found.</div>'; return; }
    for (const e of emps) {
      const item = el('div', 'emp-item');
      if (selectedEmp && selectedEmp.emp_id === e.emp_id) item.classList.add('active');
      const left = el('div');
      const idline = `${e.emp_id} · ${e.team || '—'}` + (e.monitoring_enabled === false ? ' · ⛔ monitoring off' : '');
      left.append(el('div', 'nm', e.name), el('div', 'id', idline));
      const dot = el('span', 'live-dot');
      if (e.monitoring_enabled === false) dot.classList.add('off');
      else if (e.last_status === 'active') dot.classList.add('active');
      else if (e.last_status === 'locked') dot.classList.add('locked');
      item.append(left, dot);
      item.addEventListener('click', () => selectEmployee(e));
      list.append(item);
    }
  } catch (err) { list.innerHTML = `<div class="emp-item muted">${err.message}</div>`; }
}
$('emp-search').addEventListener('input', debounce((e) => loadEmployees(e.target.value), 250));

// ── employee detail ────────────────────────────────────────────────────────────
function selectEmployee(e) {
  selectedEmp = e; selectedDay = '';
  document.querySelectorAll('.emp-item').forEach(n => n.classList.remove('active'));
  [...document.querySelectorAll('.emp-item')].find(n => n.querySelector('.id')?.textContent.startsWith(e.emp_id))?.classList.add('active');
  $('detail-empty').classList.add('hidden');
  $('detail-content').classList.remove('hidden');
  $('d-name').textContent = e.name;
  $('d-sub').textContent = `${e.emp_id} · ${e.designation || '—'} · ${e.team || '—'} · login: ${e.device_username}`;
  const chip = $('d-status');
  chip.className = 'status-chip ' + (e.last_status || 'ended');
  chip.textContent = e.last_status ? e.last_status.toUpperCase() : 'NO ACTIVITY';
  renderMonitorToggle(e);
  calMonth = startOfMonth(new Date());
  renderCalendar();
  loadSessions();
}

// Stop / Resume monitoring button reflects the employee's monitoring_enabled flag.
function renderMonitorToggle(e) {
  const btn = $('monitor-toggle');
  const enabled = e.monitoring_enabled !== false;
  btn.textContent = enabled ? 'Stop monitoring' : 'Resume monitoring';
  btn.className = enabled ? 'danger' : 'primary';
  btn.onclick = async () => {
    const turnOff = enabled;
    if (turnOff && !confirm(`Stop monitoring ${e.name} (${e.emp_id})?\nThey will get a "You are out of monitoring" pop-up and tracking stops immediately.`)) return;
    btn.disabled = true;
    try {
      await api(`/employees/${e.emp_id}/monitoring`, { method: 'POST', body: JSON.stringify({ enabled: !turnOff }) });
      e.monitoring_enabled = !turnOff;
      renderMonitorToggle(e);
      loadStats();
      loadEmployees($('emp-search').value);
    } catch (err) { alert(err.message); }
    finally { btn.disabled = false; }
  };
}

// date range
$('apply-range').addEventListener('click', () => { selectedDay = ''; loadSessions(); });
$('clear-range').addEventListener('click', () => { $('from-date').value = ''; $('to-date').value = ''; selectedDay = ''; loadSessions(); });
$('cal-prev').addEventListener('click', () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth()-1, 1); renderCalendar(); });
$('cal-next').addEventListener('click', () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth()+1, 1); renderCalendar(); });

// ── calendar ────────────────────────────────────────────────────────────────
async function renderCalendar() {
  if (!selectedEmp) return;
  const first = startOfMonth(calMonth);
  const last = new Date(calMonth.getFullYear(), calMonth.getMonth()+1, 0);
  $('cal-label').textContent = first.toLocaleString([], { month: 'long', year: 'numeric' });
  let data = [];
  try {
    data = await api(`/calendar?empId=${selectedEmp.emp_id}&from=${ymd(first)}&to=${ymd(last)}`);
  } catch {}
  const byDay = {};
  let max = 1;
  for (const d of data) { const key = ymd(new Date(d.day)); byDay[key] = d; max = Math.max(max, d.sessions); }

  const cal = $('calendar'); cal.innerHTML = '';
  for (const dow of ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']) cal.append(el('div', 'cal-dow', dow));
  for (let i = 0; i < first.getDay(); i++) cal.append(el('div', 'cal-day empty'));
  const todayStr = ymd(new Date());
  for (let day = 1; day <= last.getDate(); day++) {
    const date = new Date(calMonth.getFullYear(), calMonth.getMonth(), day);
    const key = ymd(date);
    const info = byDay[key];
    const level = !info ? 0 : info.sessions >= max*0.66 ? 3 : info.sessions >= max*0.33 ? 2 : 1;
    const cell = el('div', `cal-day d${level}`);
    if (key === todayStr) cell.classList.add('today');
    if (key === selectedDay) cell.classList.add('selected');
    cell.append(el('div', 'dnum', String(day)));
    if (info) cell.append(el('div', 'dmeta', `${info.sessions}🔑${info.idle_locks?` · ${info.idle_locks}🔒`:''}`));
    cell.title = info ? `${info.sessions} session(s), ${fmtDur(info.total_seconds)} monitored, ${info.idle_locks} idle lock(s)` : 'No activity';
    cell.addEventListener('click', () => {
      selectedDay = (selectedDay === key) ? '' : key;
      $('from-date').value = ''; $('to-date').value = '';
      renderCalendar(); loadSessions();
    });
    cal.append(cell);
  }
}

// ── sessions table ────────────────────────────────────────────────────────────
async function loadSessions() {
  if (!selectedEmp) return;
  let from = $('from-date').value, to = $('to-date').value;
  if (selectedDay) { from = selectedDay; to = selectedDay; }
  const body = $('sessions-body');
  body.innerHTML = '<tr><td colspan="7" class="muted">Loading…</td></tr>';
  try {
    const q = `/sessions?empId=${selectedEmp.emp_id}&from=${from||''}&to=${to||''}`;
    const sessions = await api(q);
    // fetch idle-lock counts via events lazily? We show counts from a quick per-session lookup.
    $('sess-count').textContent = `${sessions.length} session(s)` + (selectedDay ? ` on ${selectedDay}` : '');
    body.innerHTML = '';
    if (!sessions.length) { body.innerHTML = '<tr><td colspan="7" class="muted">No sessions in this range.</td></tr>'; return; }
    for (const s of sessions) {
      const tr = el('tr');
      tr.innerHTML = `
        <td>${fmtDateTime(s.login_at)}</td>
        <td>${s.logout_at ? fmtTime(s.logout_at) : '<span class="muted">—</span>'}</td>
        <td>${fmtDur(s.duration_seconds)}</td>
        <td>${s.hostname || '—'}</td>
        <td data-locks="${s.id}">…</td>
        <td><span class="badge ${s.status}">${s.status}</span></td>
        <td><button class="ghost" data-sess="${s.id}">Trail</button></td>`;
      body.append(tr);
    }
    body.querySelectorAll('button[data-sess]').forEach(b =>
      b.addEventListener('click', () => openTrail(b.dataset.sess)));
    // fill idle-lock counts
    sessions.forEach(s => fillLockCount(s.id));
  } catch (err) { body.innerHTML = `<tr><td colspan="7" class="muted">${err.message}</td></tr>`; }
}

async function fillLockCount(sessionId) {
  try {
    const events = await api(`/sessions/${sessionId}/events`);
    const n = events.filter(e => e.event_type === 'idle_lock').length;
    const cell = document.querySelector(`td[data-locks="${sessionId}"]`);
    if (cell) cell.innerHTML = n ? `🔒 ${n}` : '<span class="muted">0</span>';
  } catch {}
}

// ── event trail modal ────────────────────────────────────────────────────────
async function openTrail(sessionId) {
  $('modal').classList.remove('hidden');
  $('modal-body').innerHTML = 'Loading…';
  try {
    const events = await api(`/sessions/${sessionId}/events`);
    const wrap = el('div', 'timeline');
    const labels = { login: 'Logged in', heartbeat: 'Heartbeat', idle_lock: 'Idle — screen locked',
      reauth_success: 'Re-authenticated', reauth_failed: 'Re-auth FAILED', login_failed: 'Login FAILED',
      unlock: 'Unlocked', logout: 'Logged out',
      monitoring_stopped: 'Monitoring STOPPED by admin', monitoring_resumed: 'Monitoring resumed by admin' };
    for (const e of events) {
      const item = el('div', 'tl-item ' + e.event_type);
      let extra = '';
      if (e.idle_seconds != null) extra += ` · idle ${fmtDur(e.idle_seconds)}`;
      if (e.attempted_username) extra += ` · tried “${e.attempted_username}”`;
      if (e.ip) extra += ` · ${e.ip}`;
      item.innerHTML = `<div class="tl-type">${labels[e.event_type] || e.event_type}</div>
        <div class="tl-time">${fmtDateTime(e.occurred_at)}${extra}</div>`;
      wrap.append(item);
    }
    if (!events.length) wrap.innerHTML = '<p class="muted">No events recorded.</p>';
    $('modal-body').innerHTML = ''; $('modal-body').append(wrap);
  } catch (err) { $('modal-body').textContent = err.message; }
}
$('modal-close').addEventListener('click', () => $('modal').classList.add('hidden'));
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('modal').classList.add('hidden'); });

// ── boot ──────────────────────────────────────────────────────────────────────
if (token) {
  // validate token by hitting stats; if invalid, api() will logout()
  api('/stats').then(enterApp).catch(() => logout());
} else {
  logout();
}
// periodic refresh of stats + directory live dots while signed in
setInterval(() => { if (token && !$('app-view').classList.contains('hidden')) { loadStats(); loadEmployees($('emp-search').value); } }, 30000);
