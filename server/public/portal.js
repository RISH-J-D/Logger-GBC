// ── Struzon Employee Portal (role-based: employee / TL / reporting manager) ──
const API = '/api/portal';
let token = localStorage.getItem('dl_portal_token') || '';
let me = null;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const fmtDur = (s) => { if (s == null) return '—'; s = Math.max(0, s|0); const h = Math.floor(s/3600), m = Math.floor(s%3600/60); return h ? `${h}h ${m}m` : `${m}m`; };
const fmtDT = (s) => s ? new Date(s).toLocaleString() : '—';
const fmtT = (s) => s ? new Date(s).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '—';
const ROLE_LABEL = { rm: 'Reporting Manager', tl: 'Team Leader', employee: 'Employee' };
const REASON_LABEL = { meeting: 'Meeting', break: 'Break / Lunch', end_of_day: 'Logged off (day)', other: 'Other' };

async function api(path) {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
  if (!res.ok) throw new Error((await res.json().catch(()=>({}))).error || res.statusText);
  return res.json();
}

// ── auth ─────────────────────────────────────────────────────────────────────
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault(); $('login-error').textContent = '';
  try {
    const r = await fetch(API + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('login-user').value, password: $('login-pass').value }) });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'Login failed');
    token = d.token; localStorage.setItem('dl_portal_token', token);
    enter();
  } catch (err) { $('login-error').textContent = err.message; }
});
$('logout-btn').addEventListener('click', logout);
function logout() { token = ''; localStorage.removeItem('dl_portal_token'); $('app-view').classList.add('hidden'); $('login-view').classList.remove('hidden'); }

async function enter() {
  $('login-view').classList.add('hidden'); $('app-view').classList.remove('hidden');
  me = await api('/me');
  $('who').textContent = `${me.name} · ${me.emp_id}`;
  $('role-badge').textContent = ROLE_LABEL[me.role] || me.role;
  $('role-badge').className = 'status-chip active';
  $('my-name').textContent = `My work hours — ${me.name}`;
  await load();
}

const range = () => `from=${$('from-date').value||''}&to=${$('to-date').value||''}`;
$('apply').addEventListener('click', load);
$('my-detail-btn').addEventListener('click', () => openDetail(me.emp_id, me.name));

async function load() {
  const data = await api('/scope?' + range());
  const mine = data.people.find((p) => p.emp_id === me.emp_id) || {};
  renderMyStats(mine);
  if (me.role === 'tl' || me.role === 'rm') renderTeam(data.people);
  else $('team-section').classList.add('hidden');
}

function statCard(label, val, cls) {
  const c = el('div', 'stat ' + (cls||'')); c.append(el('div','n',val), el('div','l',label)); return c;
}

function renderMyStats(m) {
  const box = $('my-stats'); box.innerHTML = '';
  box.append(
    statCard('Today · active', fmtDur(m.today_active), 'green'),
    statCard('Today · logged in', fmtDur(m.today_loggedin), 'accent'),
    statCard('Range · active', fmtDur(m.range_active), 'green'),
    statCard('Range · logged in', fmtDur(m.range_loggedin), 'accent'),
  );
  if (m.current_project) {
    const p = el('div', 'stat'); p.append(el('div','n', m.current_project), el('div','l','Current project'));
    box.append(p);
  }
}

// ── team / org (TL + RM) ─────────────────────────────────────────────────────
function renderTeam(people) {
  $('team-section').classList.remove('hidden');
  $('team-title').textContent = me.role === 'rm' ? 'My organisation' : 'My team';
  const members = people.filter((p) => p.emp_id !== me.emp_id);
  drawGroups(members);
  $('team-search').oninput = () => {
    const q = $('team-search').value.toLowerCase();
    drawGroups(members.filter((p) => (p.name+p.emp_id+(p.team||'')).toLowerCase().includes(q)));
  };
}

function drawGroups(members) {
  const wrap = $('team-groups'); wrap.innerHTML = '';
  if (!members.length) { wrap.innerHTML = '<p class="muted">No team members.</p>'; return; }
  // RM groups by team; TL shows a flat list.
  const groups = {};
  for (const p of members) { const k = me.role === 'rm' ? (p.team || 'Unassigned') : '__all__'; (groups[k] ||= []).push(p); }
  for (const key of Object.keys(groups).sort()) {
    if (key !== '__all__') wrap.append(el('h4', null, `${key} <span class="muted">(${groups[key].length})</span>`));
    const table = el('table', 'data');
    table.innerHTML = '<thead><tr><th>Name</th><th>Emp ID</th><th>Team</th><th>Today active</th><th>Today logged in</th><th>Status</th><th>Project</th></tr></thead>';
    const tb = el('tbody');
    for (const p of groups[key].sort((a,b)=>a.name.localeCompare(b.name))) {
      const tr = el('tr');
      tr.style.cursor = 'pointer';
      tr.innerHTML = `<td><b>${p.name}</b></td><td>${p.emp_id}</td><td>${p.team||'—'}</td>
        <td>${fmtDur(p.today_active)}</td><td>${fmtDur(p.today_loggedin)}</td>
        <td><span class="badge ${p.last_status||'ended'}">${p.last_status||'—'}</span></td>
        <td>${p.current_project||'—'}</td>`;
      tr.onclick = () => openDetail(p.emp_id, p.name);
      tb.append(tr);
    }
    table.append(tb); wrap.append(table);
  }
}

// ── detail modal ─────────────────────────────────────────────────────────────
async function openDetail(empId, name) {
  $('modal').classList.remove('hidden');
  $('m-title').textContent = name;
  $('m-days').innerHTML = '<tr><td colspan="5" class="muted">Loading…</td></tr>';
  $('m-sessions').innerHTML = '';
  try {
    const [days, sessions] = await Promise.all([
      api(`/hours?empId=${empId}&${range()}`),
      api(`/sessions?empId=${empId}&${range()}`),
    ]);
    const tot = days.reduce((a,d)=>({li:a.li+d.loggedin_seconds, ac:a.ac+d.active_seconds, id:a.id+d.idle_seconds}),{li:0,ac:0,id:0});
    $('m-stats').innerHTML = '';
    $('m-stats').append(
      statCard('Logged in', fmtDur(tot.li), 'accent'),
      statCard('Active', fmtDur(tot.ac), 'green'),
      statCard('Idle', fmtDur(tot.id), 'yellow'),
      statCard('Days worked', String(days.length)),
    );
    $('m-days').innerHTML = days.length ? '' : '<tr><td colspan="5" class="muted">No activity in range.</td></tr>';
    for (const d of days) {
      const day = new Date(d.day).toLocaleDateString();
      $('m-days').append(el('tr', null,
        `<td>${day}</td><td>${d.sessions}</td><td>${fmtDur(d.loggedin_seconds)}</td><td>${fmtDur(d.active_seconds)}</td><td>${fmtDur(d.idle_seconds)}</td>`));
    }
    $('m-sessions').innerHTML = sessions.length ? '' : '<tr><td colspan="6" class="muted">No sessions.</td></tr>';
    for (const s of sessions) {
      const reason = s.logout_reason ? (REASON_LABEL[s.logout_reason]||s.logout_reason) + (s.logout_note?` — ${s.logout_note}`:'')
                    : (s.end_reason && s.end_reason!=='logout' ? s.end_reason : '—');
      $('m-sessions').append(el('tr', null,
        `<td>${fmtDT(s.login_at)}</td><td>${s.logout_at?fmtT(s.logout_at):'<span class="muted">active</span>'}</td>
         <td>${fmtDur(s.loggedin_seconds)}</td><td>${fmtDur(s.active_seconds)}</td>
         <td>${s.project||'—'}</td><td>${reason}</td>`));
    }
  } catch (err) { $('m-days').innerHTML = `<tr><td colspan="5" class="muted">${err.message}</td></tr>`; }
}
$('m-close').addEventListener('click', () => $('modal').classList.add('hidden'));
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('modal').classList.add('hidden'); });

// ── boot ──────────────────────────────────────────────────────────────────────
if (token) api('/me').then(enter).catch(logout); else logout();
