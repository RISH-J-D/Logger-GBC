// Endpoints called by the desktop agent installed on each employee machine.
const express = require('express');
const db = require('../db');
const { verifyEmployee, requireAgentKey } = require('../auth');

const router = express.Router();
router.use(requireAgentKey);

const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();

// Trim an employee row down to what the agent needs to display.
const publicEmployee = (e) => ({
  emp_id: e.emp_id,
  name: e.name,
  designation: e.designation,
  team: e.team,
  device_username: e.device_username,
});

// Current monitoring on/off flag for an employee id.
async function monitoringEnabled(employeeId) {
  const { rows } = await db.query('SELECT monitoring_enabled FROM employees WHERE id = $1', [employeeId]);
  return rows[0] ? rows[0].monitoring_enabled : true;
}

async function logEvent({ sessionId, employeeId, type, idleSeconds, attemptedUsername, meta, ip }) {
  await db.query(
    `INSERT INTO events (session_id, employee_id, event_type, idle_seconds, attempted_username, meta, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [sessionId || null, employeeId || null, type, idleSeconds ?? null,
     attemptedUsername || null, meta ? JSON.stringify(meta) : null, ip || null]
  );
}

// ── Project list for the sign-in dropdown ───────────────────────────────────
router.get('/projects', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT name FROM projects WHERE is_active ORDER BY name');
    res.json(rows.map((r) => r.name));
  } catch (err) { res.status(500).json([]); }
});

// ── Login: the employee logs in / starts monitoring ────────────────────────
router.post('/login', async (req, res) => {
  const { username, password, hostname, platform, agent_version, project } = req.body || {};
  const ip = clientIp(req);
  try {
    const emp = await verifyEmployee(username, password);
    if (!emp) {
      await logEvent({ type: 'login_failed', attemptedUsername: username, ip,
        meta: { hostname, platform } });
      return res.status(401).json({ ok: false, error: 'Invalid Employee ID / username or password' });
    }

    // If the admin has remotely disabled monitoring for this employee, don't
    // start a session — tell the agent it's out of monitoring.
    if (!emp.monitoring_enabled) {
      return res.json({ ok: true, monitoring_enabled: false, employee: publicEmployee(emp) });
    }

    if (emp.require_password_change) {
      return res.json({ ok: true, require_password_change: true, employee: publicEmployee(emp) });
    }

    const { rows } = await db.query(
      `INSERT INTO sessions (employee_id, hostname, platform, agent_version, ip, status, project)
       VALUES ($1,$2,$3,$4,$5,'active',$6) RETURNING id, login_at`,
      [emp.id, hostname || null, platform || null, agent_version || null, ip, project || null]
    );
    const session = rows[0];
    await logEvent({ sessionId: session.id, employeeId: emp.id, type: 'login', ip,
      meta: { hostname, platform, project: project || null } });

    res.json({
      ok: true,
      monitoring_enabled: true,
      session_id: session.id,
      login_at: session.login_at,
      employee: publicEmployee(emp),
    });
  } catch (err) {
    console.error('login error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── Heartbeat: periodic liveness + current idle time ───────────────────────
router.post('/heartbeat', async (req, res) => {
  const { session_id, idle_seconds } = req.body || {};
  try {
    const { rows } = await db.query(
      'SELECT employee_id, status FROM sessions WHERE id = $1', [session_id]);
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'Unknown session' });
    // Refresh liveness only while still active.
    if (rows[0].status !== 'ended') {
      await db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [session_id]);
    }
    // Tell the agent whether the admin still wants this employee monitored. We
    // report this even for an admin-ended session so the agent reacts (the stop
    // endpoint ends the session immediately so the portal reflects it).
    const enabled = await monitoringEnabled(rows[0].employee_id);
    res.json({ ok: true, monitoring_enabled: enabled, session_ended: rows[0].status === 'ended' });
  } catch (err) {
    console.error('heartbeat error:', err.message);
    res.status(500).json({ ok: false });
  }
});

// Lightweight status poll used by the agent while it sits in the "stopped by
// admin" state, so it can detect when monitoring is re-enabled.
router.post('/status', async (req, res) => {
  const { emp_id } = req.body || {};
  try {
    const { rows } = await db.query(
      'SELECT monitoring_enabled FROM employees WHERE UPPER(emp_id) = UPPER($1)', [emp_id]);
    if (!rows[0]) return res.status(404).json({ ok: false });
    res.json({ ok: true, monitoring_enabled: rows[0].monitoring_enabled });
  } catch (err) {
    res.status(500).json({ ok: false });
  }
});

// ── Idle lock: 5-minute inactivity reached, agent locked the screen ────────
router.post('/idle-lock', async (req, res) => {
  const { session_id, idle_seconds } = req.body || {};
  try {
    const upd = await db.query(
      `UPDATE sessions SET status = 'locked', last_seen_at = now()
       WHERE id = $1 AND status <> 'ended' RETURNING employee_id`,
      [session_id]
    );
    if (!upd.rows[0]) return res.status(404).json({ ok: false, error: 'Unknown or ended session' });
    await logEvent({ sessionId: session_id, employeeId: upd.rows[0].employee_id,
      type: 'idle_lock', idleSeconds: idle_seconds, ip: clientIp(req) });
    res.json({ ok: true });
  } catch (err) {
    console.error('idle-lock error:', err.message);
    res.status(500).json({ ok: false });
  }
});

// ── Re-auth: activity resumed, employee re-entered credentials at lock screen
router.post('/reauth', async (req, res) => {
  const { session_id, username, password, idle_seconds } = req.body || {};
  const ip = clientIp(req);
  try {
    const { rows } = await db.query('SELECT employee_id FROM sessions WHERE id = $1', [session_id]);
    const sessionEmployeeId = rows[0] ? rows[0].employee_id : null;

    const emp = await verifyEmployee(username, password);
    // The person unlocking must match the employee who owns this session.
    if (!emp || (sessionEmployeeId && emp.id !== sessionEmployeeId)) {
      await logEvent({ sessionId: session_id, employeeId: sessionEmployeeId,
        type: 'reauth_failed', attemptedUsername: username, idleSeconds: idle_seconds, ip,
        meta: emp && emp.id !== sessionEmployeeId ? { reason: 'different_employee' } : { reason: 'bad_credentials' } });
      return res.status(401).json({ ok: false, error: 'Authentication failed' });
    }

    await db.query(
      `UPDATE sessions SET status = 'active', last_seen_at = now() WHERE id = $1`,
      [session_id]
    );
    await logEvent({ sessionId: session_id, employeeId: emp.id, type: 'reauth_success',
      idleSeconds: idle_seconds, ip });
    res.json({ ok: true, employee: publicEmployee(emp) });
  } catch (err) {
    console.error('reauth error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── Logout: monitoring stopped (app closed / user logged off / shutdown) ────
router.post('/logout', async (req, res) => {
  const { session_id, reason, logout_reason, logout_note } = req.body || {};
  try {
    const upd = await db.query(
      `UPDATE sessions SET status = 'ended', logout_at = now(), end_reason = $2,
              logout_reason = $3, logout_note = $4
       WHERE id = $1 AND status <> 'ended' RETURNING employee_id`,
      [session_id, reason || 'logout', logout_reason || null, logout_note || null]
    );
    if (upd.rows[0]) {
      await logEvent({ sessionId: session_id, employeeId: upd.rows[0].employee_id,
        type: 'logout', ip: clientIp(req),
        meta: { reason: reason || 'logout', logout_reason: logout_reason || null, logout_note: logout_note || null } });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('logout error:', err.message);
    res.status(500).json({ ok: false });
  }
});

// ── Change password: 1st time users ──────────────────────────────────────────
router.post('/change-password', async (req, res) => {
  const { username, old_password, new_password } = req.body || {};
  try {
    const emp = await verifyEmployee(username, old_password);
    if (!emp) return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync(new_password, 10);
    
    await db.query(
      `UPDATE employees SET password_hash = $1, require_password_change = false WHERE id = $2`,
      [hash, emp.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('change-password error:', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── Offline sync: agent sends cached logs when reconnecting ──────────────────
router.post('/sync-offline', async (req, res) => {
  const { session_id, logs } = req.body || {};
  const ip = clientIp(req);
  try {
    const { rows } = await db.query('SELECT employee_id FROM sessions WHERE id = $1', [session_id]);
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'Unknown session' });
    const empId = rows[0].employee_id;
    
    if (Array.isArray(logs)) {
      for (const log of logs) {
        await db.query(
          `INSERT INTO events (session_id, employee_id, event_type, idle_seconds, occurred_at, ip)
           VALUES ($1,$2,$3,$4,to_timestamp($5 / 1000.0),$6)`,
          [session_id, empId, log.type || 'heartbeat', log.idle_seconds || 0, log.time || Date.now(), ip]
        );
      }
    }
    await db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [session_id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('sync-offline error:', err.message);
    res.status(500).json({ ok: false });
  }
});

module.exports = router;
