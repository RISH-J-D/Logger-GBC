// Org-hierarchy role resolution for the employee portal.
//   employee – sees only themselves
//   tl       – team leader: themselves + their team members
//   rm       – reporting manager: themselves + all teams/TLs under them
const db = require('./db');

// Determine an employee's portal role from the hierarchy links.
async function resolveRole(empId) {
  const rm = await db.query('SELECT 1 FROM employees WHERE rm_emp_id=$1 LIMIT 1', [empId]);
  if (rm.rows.length) return 'rm';
  const tl = await db.query('SELECT 1 FROM employees WHERE tl_emp_id=$1 LIMIT 1', [empId]);
  if (tl.rows.length) return 'tl';
  return 'employee';
}

// The set of emp_ids this user is allowed to see (always includes self).
async function scopeEmpIds(empId, role) {
  if (role === 'rm') {
    const { rows } = await db.query(
      `SELECT emp_id FROM employees
       WHERE emp_id=$1 OR rm_emp_id=$1
          OR tl_emp_id IN (SELECT emp_id FROM employees WHERE rm_emp_id=$1)`, [empId]);
    return rows.map((r) => r.emp_id);
  }
  if (role === 'tl') {
    const { rows } = await db.query(
      'SELECT emp_id FROM employees WHERE emp_id=$1 OR tl_emp_id=$1', [empId]);
    return rows.map((r) => r.emp_id);
  }
  return [empId];
}

module.exports = { resolveRole, scopeEmpIds };
