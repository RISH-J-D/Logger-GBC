const $ = (id) => document.getElementById(id);

(async () => {
  const ctx = await window.agent.getContext();
  if (ctx.employee) $('who').textContent = `${ctx.employee.name} · ${ctx.employee.emp_id}`;
})();

$('close').addEventListener('click', () => window.close());
