// Imports projects + teams from the seeds produced by tools/parse_projects.py
// (which reads Project Data.xlsx). Idempotent: matched by project name / team name.
// Completed projects are kept but marked inactive (hidden from the agent dropdown).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

const P_SEED = path.join(__dirname, '..', 'data', 'projects.seed.json');
const T_SEED = path.join(__dirname, '..', 'data', 'teams.seed.json');

// Skip obviously-bad team values from the spreadsheet.
const badTeam = (t) => !t || t === '0' || /^STZ/i.test(t) || /_old$/i.test(t) || t.toLowerCase() === 'multiple';

(async () => {
  const client = await pool.connect();
  let projN = 0, teamN = 0;
  try {
    const projects = JSON.parse(fs.readFileSync(P_SEED, 'utf8'));
    const teams = JSON.parse(fs.readFileSync(T_SEED, 'utf8'));
    console.log(`Importing ${projects.length} projects and ${teams.length} teams...`);

    // Replace the previously-seeded sample projects with the real ones.
    await client.query("DELETE FROM projects WHERE client IS NULL AND team IS NULL");

    for (const p of projects) {
      const active = (p.status || 'Active').toLowerCase() === 'active';
      await client.query(
        `INSERT INTO projects (name, client, team, value, rep, status, po_date, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (name) DO UPDATE SET
           client=EXCLUDED.client, team=EXCLUDED.team, value=EXCLUDED.value,
           rep=EXCLUDED.rep, status=EXCLUDED.status, po_date=EXCLUDED.po_date,
           is_active=EXCLUDED.is_active`,
        [p.name, p.client || null, badTeam(p.team) ? null : p.team,
         p.value ?? null, p.rep || null, p.status || null, p.po_date || null, active]
      );
      projN++;
    }

    for (const t of teams) {
      if (badTeam(t)) continue;
      await client.query(
        'INSERT INTO teams (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [t]);
      teamN++;
    }

    const active = (await client.query('SELECT COUNT(*) n FROM projects WHERE is_active')).rows[0].n;
    console.log(`✓ ${projN} projects imported (${active} active), ${teamN} teams.`);
  } catch (err) {
    console.error('Project import failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
