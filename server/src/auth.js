// Authentication helpers: employee credential checks + admin portal JWT sessions.
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Verify an employee by device username OR emp_id, plus password.
// Returns the employee row on success, or null on failure.
async function verifyEmployee(identifier, password) {
  if (!identifier || !password) return null;
  const id = String(identifier).trim();
  const { rows } = await db.query(
    `SELECT * FROM employees
     WHERE (LOWER(device_username) = LOWER($1) OR UPPER(emp_id) = UPPER($1))
       AND is_active = TRUE
     ORDER BY (UPPER(emp_id) = UPPER($1)) DESC, id ASC
     LIMIT 1`,
    [id]
  );
  const emp = rows[0];
  if (!emp) return null;
  return bcrypt.compareSync(password, emp.password_hash) ? emp : null;
}

// Admin portal login -> signed JWT (valid 12h).
function adminLogin(username, password) {
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    return jwt.sign({ role: 'admin', username }, JWT_SECRET, { expiresIn: '12h' });
  }
  return null;
}

// Express middleware guarding admin API routes.
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Optional shared secret to stop random clients hitting the agent API.
// If AGENT_API_KEY is unset, the check is skipped.
function requireAgentKey(req, res, next) {
  const required = process.env.AGENT_API_KEY;
  if (!required) return next();
  if (req.headers['x-agent-key'] === required) return next();
  res.status(401).json({ error: 'Invalid agent key' });
}

module.exports = { verifyEmployee, adminLogin, requireAdmin, requireAgentKey };
