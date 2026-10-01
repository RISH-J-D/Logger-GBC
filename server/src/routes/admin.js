// Endpoints powering the admin monitoring portal. All require an admin JWT
// except /login.
const express = require('express');
const db = require('../db');
const { adminLogin, requireAdmin } = require('../auth');

const router = express.Router();

// ── Admin login ────────────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const token = adminLogin(username, password);
  if (!token) return res.status(401).json({ ok: false, error: 'Invalid admin credentials' });
  res.json({ ok: true, token });
});

router.use(requireAdmin);

// ── Dashboard stats ────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [emp, active, today, locked] = await Promise.all([
      db.query('SELECT COUNT(*)::int n FROM employees WHERE is_active'),
      db.query(`SELECT COUNT(*)::int n FROM sessions WHERE status <> 'ended'`),
      db.query(`SELECT COUNT(*)::int n FROM sessions WHERE login_at::date = (now())::date`),
      db.query(`SELECT COUNT(*)::int n FROM sessions WHERE status = 'locked'`),
    ]);
    res.json({
      employees: emp.rows[0].n,
      activeSessions: active.rows[0].n,
      loginsToday: today.rows[0].n,
      lockedNow: locked.rows[0].n,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Employee list with search + last-seen rollups ──────────────────────────
router.get('/employees', async (req, res) => {
  const search = (req.query.search || '').trim();
  try {
    const { rows } = await db.query(
      `SELECT e.id, e.emp_id, e.name, e.designation, e.team, e.device_username,
              e.email, e.reporting_manager, e.team_leader, e.monitoring_enabled,
              s.login_at  AS last_login,
              s.status    AS last_status,
              s.hostname  AS last_hostname
       FROM employees e
       LEFT JOIN LATERAL (
         SELECT login_at, status, hostname FROM sessions
         WHERE employee_id = e.id ORDER BY login_at DESC LIMIT 1
       ) s ON TRUE
       WHERE ($1 = '' OR e.name ILIKE '%'||$1||'%' OR e.emp_id ILIKE '%'||$1||'%'
              OR e.device_username ILIKE '%'||$1||'%' OR e.team ILIKE '%'||$1||'%')
       ORDER BY e.emp_id
       LIMIT 500`,
      [search]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Single employee profile ────────────────────────────────────────────────
router.get('/employees/:empId', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, emp_id, name, designation, team, device_username, email,
              reporting_manager, team_leader, is_active, monitoring_enabled, created_at
       FROM employees WHERE UPPER(emp_id) = UPPER($1)`,
      [req.params.empId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Employee not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Remotely stop / resume monitoring for one employee ─────────────────────
// POST /employees/:empId/monitoring  body { enabled: true|false }
router.post('/employees/:empId/monitoring', async (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  try {
    const { rows } = await db.query(
      `UPDATE employees SET monitoring_enabled = $2, updated_at = now()
       WHERE UPPER(emp_id) = UPPER($1) RETURNING id, emp_id, name, monitoring_enabled`,
      [req.params.empId, enabled]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Employee not found' });
    const emp = rows[0];

    // When stopping, immediately end any live session so the portal reflects it.
    if (!enabled) {
      await db.query(
        `UPDATE sessions SET status='ended', logout_at=now(), end_reason='stopped_by_admin'
         WHERE employee_id = $1 AND status <> 'ended'`,
        [emp.id]
      );
    }
    await db.query(
      `INSERT INTO events (employee_id, event_type, meta)
       VALUES ($1, $2, $3)`,
      [emp.id, enabled ? 'monitoring_resumed' : 'monitoring_stopped',
       JSON.stringify({ by: req.admin.username })]
    );
    res.json({ ok: true, emp_id: emp.emp_id, monitoring_enabled: emp.monitoring_enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sessions, filterable by employee + date range ──────────────────────────
// Query params: empId, from (YYYY-MM-DD), to (YYYY-MM-DD), search
router.get('/sessions', async (req, res) => {
  const { empId, from, to } = req.query;
  const search = (req.query.search || '').trim();
  try {
    const { rows } = await db.query(
      `SELECT s.id, s.login_at, s.logout_at, s.last_seen_at, s.status, s.end_reason,
              s.hostname, s.platform, s.ip,
              EXTRACT(EPOCH FROM (COALESCE(s.logout_at, s.last_seen_at) - s.login_at))::int AS duration_seconds,
              e.emp_id, e.name, e.team, e.device_username
       FROM sessions s
       JOIN employees e ON e.id = s.employee_id
       WHERE ($1 = '' OR UPPER(e.emp_id) = UPPER($1))
         AND ($2 = '' OR e.name ILIKE '%'||$2||'%' OR e.emp_id ILIKE '%'||$2||'%'
              OR e.device_username ILIKE '%'||$2||'%' OR e.team ILIKE '%'||$2||'%')
         AND ($3 = '' OR s.login_at >= $3::date)
         AND ($4 = '' OR s.login_at < ($4::date + INTERVAL '1 day'))
       ORDER BY s.login_at DESC
       LIMIT 1000`,
      [empId || '', search, from || '', to || '']
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Detailed event trail for one session ───────────────────────────────────
router.get('/sessions/:id/events', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, event_type, occurred_at, idle_seconds, attempted_username, meta, ip
       FROM events WHERE session_id = $1 ORDER BY occurred_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Calendar rollup: per-day session counts + total monitored time ─────────
// Query: empId (optional), from, to
router.get('/calendar', async (req, res) => {
  const { empId, from, to } = req.query;
  try {
    const { rows } = await db.query(
      `SELECT s.login_at::date AS day,
              COUNT(*)::int AS sessions,
              COUNT(DISTINCT s.employee_id)::int AS employees,
              COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(s.logout_at, s.last_seen_at) - s.login_at))),0)::int AS total_seconds,
              SUM((SELECT COUNT(*) FROM events ev
                   WHERE ev.session_id = s.id AND ev.event_type = 'idle_lock'))::int AS idle_locks
       FROM sessions s
       JOIN employees e ON e.id = s.employee_id
       WHERE ($1 = '' OR UPPER(e.emp_id) = UPPER($1))
         AND ($2 = '' OR s.login_at >= $2::date)
         AND ($3 = '' OR s.login_at < ($3::date + INTERVAL '1 day'))
       GROUP BY day ORDER BY day`,
      [empId || '', from || '', to || '']
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Recent activity feed (all employees) ───────────────────────────────────
router.get('/activity', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT ev.event_type, ev.occurred_at, ev.idle_seconds, ev.attempted_username,
              e.emp_id, e.name, ev.session_id
       FROM events ev
       LEFT JOIN employees e ON e.id = ev.employee_id
       ORDER BY ev.occurred_at DESC LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
