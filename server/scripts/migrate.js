// Creates the database schema. Safe to run repeatedly (idempotent).
require('dotenv').config();
const { pool } = require('../src/db');

const SQL = `
CREATE TABLE IF NOT EXISTS employees (
  id                SERIAL PRIMARY KEY,
  emp_id            TEXT UNIQUE NOT NULL,
  name              TEXT NOT NULL,
  designation       TEXT,
  device_username   TEXT NOT NULL,  -- not unique: a few employees share a username
  password_hash     TEXT NOT NULL,
  email             TEXT,
  team              TEXT,
  reporting_manager TEXT,
  team_leader       TEXT,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One monitoring session = from login until the agent reports a logout/close.
CREATE TABLE IF NOT EXISTS sessions (
  id            SERIAL PRIMARY KEY,
  employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  hostname      TEXT,
  platform      TEXT,
  agent_version TEXT,
  ip            TEXT,
  login_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  logout_at     TIMESTAMPTZ,
  end_reason    TEXT,                       -- logout | shutdown | timeout | replaced
  status        TEXT NOT NULL DEFAULT 'active'  -- active | locked | ended
);

-- Granular activity trail within a session.
CREATE TABLE IF NOT EXISTS events (
  id            SERIAL PRIMARY KEY,
  session_id    INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  employee_id   INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  event_type    TEXT NOT NULL,    -- login | heartbeat | idle_lock | reauth_success
                                  -- | reauth_failed | login_failed | unlock | logout
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  idle_seconds  INTEGER,
  attempted_username TEXT,
  meta          JSONB,
  ip            TEXT
);

-- Drop the old unique constraint if a previous migration created it.
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_device_username_key;
-- Remote on/off switch the admin controls from the portal.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS monitoring_enabled BOOLEAN NOT NULL DEFAULT TRUE;
-- Org hierarchy links (resolved from team_leader / reporting_manager names).
ALTER TABLE employees ADD COLUMN IF NOT EXISTS tl_emp_id TEXT;   -- this person's team leader
ALTER TABLE employees ADD COLUMN IF NOT EXISTS rm_emp_id TEXT;   -- this person's reporting manager
-- First time users must change password
ALTER TABLE employees ADD COLUMN IF NOT EXISTS require_password_change BOOLEAN NOT NULL DEFAULT TRUE;


-- Selectable projects/tasks shown in the agent sign-in dropdown (from Project Data.xlsx).
CREATE TABLE IF NOT EXISTS projects (
  id         SERIAL PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  client     TEXT,
  team       TEXT,
  value      NUMERIC,
  rep        TEXT,
  status     TEXT,
  po_date    DATE,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS client  TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS team    TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS value   NUMERIC;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS rep     TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS status  TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS po_date DATE;
CREATE INDEX IF NOT EXISTS idx_projects_team ON projects(team);

-- Teams (from the project data).
CREATE TABLE IF NOT EXISTS teams (
  id        SERIAL PRIMARY KEY,
  name      TEXT UNIQUE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

-- What the employee was working on this session + how they ended it.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS project       TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS logout_reason TEXT;  -- meeting | break | end_of_day | other
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS logout_note   TEXT;
CREATE INDEX IF NOT EXISTS idx_employees_username    ON employees(LOWER(device_username));

CREATE INDEX IF NOT EXISTS idx_sessions_employee   ON sessions(employee_id);
CREATE INDEX IF NOT EXISTS idx_sessions_login_at   ON sessions(login_at);
CREATE INDEX IF NOT EXISTS idx_sessions_status     ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_events_session      ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_employee     ON events(employee_id);
CREATE INDEX IF NOT EXISTS idx_events_occurred_at  ON events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_type         ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_employees_tl         ON employees(tl_emp_id);
CREATE INDEX IF NOT EXISTS idx_employees_rm         ON employees(rm_emp_id);
`;

(async () => {
  try {
    await pool.query(SQL);
    console.log('✓ Schema created / verified.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
