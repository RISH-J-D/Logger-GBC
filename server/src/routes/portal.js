// Employee-facing portal: role-scoped views (employee / TL / reporting manager).
// Auth uses the employee's own Emp ID + password. Role + visible scope are
// derived from the org hierarchy.
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { verifyEmployee } = require('../auth');
const { resolveRole, scopeEmpIds } = require('../roles');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';

// ── auth ────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const emp = await verifyEmployee(username, password);
    if (!emp) return res.status(401).json({ ok: false, error: 'Invalid Employee ID or password' });
    const role = await resolveRole(emp.emp_id);
    const token = jwt.sign({ emp_id: emp.emp_id, name: emp.name, role }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ ok: true, token, employee: { emp_id: emp.emp_id, name: emp.name, role } });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

function requirePortal(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}
router.use(requirePortal);

// Per-session locked (idle) seconds = time from each idle_lock to the next event.
const LOCKED_CTE = `
  locked AS (
    SELECT session_id, SUM(EXTRACT(EPOCH FROM (next_at - occurred_at)))::int AS locked_seconds
    FROM (
      SELECT session_id, event_type, occurred_at,
             LEAD(occurred_at) OVER (PARTITION BY session_id ORDER BY occurred_at) AS next_at
      FROM events
    ) e WHERE event_type='idle_lock' AND next_at IS NOT NULL
    GROUP BY session_id
  )`;

// ── who am I + my role ──────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT emp_id, name, designation, team, email, reporting_manager, team_leader
       FROM employees WHERE emp_id=$1`, [req.user.emp_id]);
    res.json({ ...rows[0], role: req.user.role });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── people I'm allowed to see, each with rolled-up hours ────────────────────
// Query: from, to (range for the range totals; today is always included)
router.get('/scope', async (req, res) => {
  const from = req.query.from || '';
  const to = req.query.to || '';
  try {
    const ids = await scopeEmpIds(req.user.emp_id, req.user.role);
    const { rows } = await db.query(
      `WITH ${LOCKED_CTE},
       sess AS (
         SELECT e.emp_id, e.name, e.designation, e.team, e.tl_emp_id, e.rm_emp_id,
                s.login_at, s.logout_at, s.last_seen_at, s.status, s.project,
                EXTRACT(EPOCH FROM (COALESCE(s.logout_at,s.last_seen_at)-s.login_at))::int AS li,
                COALESCE(l.locked_seconds,0) AS lk
         FROM sessions s JOIN employees e ON e.id=s.employee_id
         LEFT JOIN locked l ON l.session_id=s.id
         WHERE e.emp_id = ANY($1)
       )
       SELECT e.emp_id, e.name, e.designation, e.team, e.tl_emp_id, e.rm_emp_id,
         COALESCE(SUM(s.li) FILTER (WHERE s.login_at::date = now()::date),0)::int AS today_loggedin,
         COALESCE(SUM(s.li - s.lk) FILTER (WHERE s.login_at::date = now()::date),0)::int AS today_active,
         COALESCE(SUM(s.li) FILTER (WHERE ($2='' OR s.login_at>=$2::date) AND ($3='' OR s.login_at<($3::date+INTERVAL '1 day'))),0)::int AS range_loggedin,
         COALESCE(SUM(s.li - s.lk) FILTER (WHERE ($2='' OR s.login_at>=$2::date) AND ($3='' OR s.login_at<($3::date+INTERVAL '1 day'))),0)::int AS range_active,
         (SELECT status FROM sess x WHERE x.emp_id=e.emp_id ORDER BY x.login_at DESC LIMIT 1) AS last_status,
         (SELECT project FROM sess x WHERE x.emp_id=e.emp_id ORDER BY x.login_at DESC LIMIT 1) AS current_project,
         MAX(s.login_at) AS last_login
       FROM employees e LEFT JOIN sess s ON s.emp_id=e.emp_id
       WHERE e.emp_id = ANY($1)
       GROUP BY e.emp_id, e.name, e.designation, e.team, e.tl_emp_id, e.rm_emp_id
       ORDER BY e.name`,
      [ids, from, to]);
    res.json({ role: req.user.role, me: req.user.emp_id, people: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── per-day hours for one employee (must be in my scope) ────────────────────
router.get('/hours', async (req, res) => {
  const { empId, from, to } = req.query;
  try {
    const ids = await scopeEmpIds(req.user.emp_id, req.user.role);
    const target = empId || req.user.emp_id;
    if (!ids.includes(target)) return res.status(403).json({ error: 'Not in your scope' });
    const { rows } = await db.query(
      `WITH ${LOCKED_CTE}
       SELECT s.login_at::date AS day,
         COUNT(*)::int AS sessions,
         SUM(EXTRACT(EPOCH FROM (COALESCE(s.logout_at,s.last_seen_at)-s.login_at)))::int AS loggedin_seconds,
         COALESCE(SUM(l.locked_seconds),0)::int AS idle_seconds
       FROM sessions s JOIN employees e ON e.id=s.employee_id
       LEFT JOIN locked l ON l.session_id=s.id
       WHERE e.emp_id=$1
         AND ($2='' OR s.login_at>=$2::date)
         AND ($3='' OR s.login_at<($3::date+INTERVAL '1 day'))
       GROUP BY day ORDER BY day`,
      [target, from || '', to || '']);
    res.json(rows.map((r) => ({ ...r, active_seconds: Math.max(0, r.loggedin_seconds - r.idle_seconds) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── sessions for one employee (must be in my scope) ─────────────────────────
router.get('/sessions', async (req, res) => {
  const { empId, from, to } = req.query;
  try {
    const ids = await scopeEmpIds(req.user.emp_id, req.user.role);
    const target = empId || req.user.emp_id;
    if (!ids.includes(target)) return res.status(403).json({ error: 'Not in your scope' });
    const { rows } = await db.query(
      `WITH ${LOCKED_CTE}
       SELECT s.id, s.login_at, s.logout_at, s.last_seen_at, s.status, s.hostname,
              s.project, s.logout_reason, s.logout_note, s.end_reason,
              EXTRACT(EPOCH FROM (COALESCE(s.logout_at,s.last_seen_at)-s.login_at))::int AS loggedin_seconds,
              COALESCE(l.locked_seconds,0)::int AS idle_seconds
       FROM sessions s JOIN employees e ON e.id=s.employee_id
       LEFT JOIN locked l ON l.session_id=s.id
       WHERE e.emp_id=$1
         AND ($2='' OR s.login_at>=$2::date)
         AND ($3='' OR s.login_at<($3::date+INTERVAL '1 day'))
       ORDER BY s.login_at DESC LIMIT 500`,
      [target, from || '', to || '']);
    res.json(rows.map((r) => ({ ...r, active_seconds: Math.max(0, r.loggedin_seconds - r.idle_seconds) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
