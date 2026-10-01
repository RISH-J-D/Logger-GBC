// Generates realistic demo sessions + events across the last ~20 days for a few
// employees, so the admin portal has something to display. SAFE TO DELETE — this
// is only for demonstration. Run: node scripts/seed-demo.js
require('dotenv').config();
const { pool } = require('../src/db');

const DEMO_EMP_IDS = ['STZ002', 'STZ001', 'STZ005', 'STZ344'];

// deterministic pseudo-random so reruns are stable-ish
let s = 12345;
const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (a) => a[Math.floor(rnd() * a.length)];

(async () => {
  const client = await pool.connect();
  try {
    const { rows: emps } = await client.query(
      `SELECT id, emp_id, device_username FROM employees WHERE emp_id = ANY($1)`, [DEMO_EMP_IDS]);
    console.log(`Seeding demo activity for ${emps.length} employees…`);

    for (const emp of emps) {
      for (let dayAgo = 20; dayAgo >= 0; dayAgo--) {
        if (rnd() < 0.18) continue;                       // some days off
        const sessionsToday = 1 + Math.floor(rnd() * 2);
        for (let k = 0; k < sessionsToday; k++) {
          const startHour = 9 + Math.floor(rnd() * 2) + k * 4;
          const login = `now() - INTERVAL '${dayAgo} days' + INTERVAL '${startHour} hours' + INTERVAL '${Math.floor(rnd()*59)} minutes'`;
          const durMin = 60 + Math.floor(rnd() * 240);
          const { rows } = await client.query(
            `INSERT INTO sessions (employee_id, hostname, platform, agent_version, ip, login_at, last_seen_at, logout_at, end_reason, status)
             VALUES ($1,$2,'win32','1.0.0','10.0.0.${Math.floor(rnd()*200)+2}',
                     ${login}, ${login} + INTERVAL '${durMin} minutes',
                     ${login} + INTERVAL '${durMin} minutes', 'logout', 'ended')
             RETURNING id, login_at`,
            [emp.id, 'SPARK-PC-' + emp.emp_id.slice(-2)]);
          const sid = rows[0].id;

          const ev = async (type, offsetMin, idle) => client.query(
            `INSERT INTO events (session_id, employee_id, event_type, occurred_at, idle_seconds, ip)
             VALUES ($1,$2,$3, ${login} + INTERVAL '${offsetMin} minutes', $4,'10.0.0.5')`,
            [sid, emp.id, type, idle ?? null]);

          await ev('login', 0);
          // a couple of idle-lock / reauth cycles
          const locks = Math.floor(rnd() * 3);
          let t = 30;
          for (let i = 0; i < locks && t < durMin - 10; i++) {
            await ev('idle_lock', t, 300);
            if (rnd() < 0.25) await ev('reauth_failed', t + 1);
            await ev('reauth_success', t + 2, 300 + Math.floor(rnd() * 120));
            t += 40 + Math.floor(rnd() * 60);
          }
          await ev('logout', durMin);
        }
      }
    }
    console.log('✓ Demo activity seeded.');
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
