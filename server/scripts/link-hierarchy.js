// Resolves each employee's team_leader / reporting_manager NAME into the matching
// employee's emp_id (tl_emp_id / rm_emp_id), so role-scoped portal queries are
// fast and reliable. Also seeds the projects dropdown. Idempotent.
require('dotenv').config();
const { pool } = require('../src/db');

// Normalise a name for matching: strip spaces/dots, uppercase.
const norm = (s) => (s || '').toUpperCase().replace(/[\s.]+/g, '');

const SEED_PROJECTS = [
  'General Work', 'Project Falcon', 'Project Phoenix', 'Project Spark',
  'Support / Maintenance', 'Documentation', 'Training', 'R&D',
];

(async () => {
  const client = await pool.connect();
  try {
    const { rows: emps } = await client.query(
      'SELECT emp_id, name, team_leader, reporting_manager FROM employees');

    // name(normalised) -> emp_id  (first match wins)
    const byName = new Map();
    for (const e of emps) if (!byName.has(norm(e.name))) byName.set(norm(e.name), e.emp_id);

    let tlLinked = 0, rmLinked = 0, tlMiss = 0, rmMiss = 0;
    for (const e of emps) {
      const tl = e.team_leader ? byName.get(norm(e.team_leader)) || null : null;
      const rm = e.reporting_manager ? byName.get(norm(e.reporting_manager)) || null : null;
      // Don't list someone as their own TL/RM.
      const tlFinal = tl && tl !== e.emp_id ? tl : null;
      const rmFinal = rm && rm !== e.emp_id ? rm : null;
      await client.query('UPDATE employees SET tl_emp_id=$2, rm_emp_id=$3 WHERE emp_id=$1',
        [e.emp_id, tlFinal, rmFinal]);
      if (e.team_leader) (tlFinal ? tlLinked++ : tlMiss++);
      if (e.reporting_manager) (rmFinal ? rmLinked++ : rmMiss++);
    }

    for (const p of SEED_PROJECTS) {
      await client.query(
        'INSERT INTO projects (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [p]);
    }

    const tls = (await client.query('SELECT COUNT(DISTINCT tl_emp_id) n FROM employees WHERE tl_emp_id IS NOT NULL')).rows[0].n;
    const rms = (await client.query('SELECT COUNT(DISTINCT rm_emp_id) n FROM employees WHERE rm_emp_id IS NOT NULL')).rows[0].n;
    console.log(`✓ Hierarchy linked. TL links: ${tlLinked} (unmatched names: ${tlMiss}), RM links: ${rmLinked} (unmatched: ${rmMiss}).`);
    console.log(`  Distinct team leaders: ${tls}, reporting managers: ${rms}.`);
    console.log(`✓ Seeded ${SEED_PROJECTS.length} projects.`);
  } catch (err) {
    console.error('Hierarchy linking failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
