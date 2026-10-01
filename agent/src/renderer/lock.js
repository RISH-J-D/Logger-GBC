const $ = (id) => document.getElementById(id);

// Secondary monitors show a backdrop only — re-auth happens on the primary.
if (location.hash === '#secondary') {
  document.body.innerHTML =
    '<div class="lock"><div class="lock-card">' +
    '<div class="big">🔒</div><h1>Session locked</h1>' +
    '<p class="who muted">Locked due to inactivity.<br>Unlock on the <b>main screen</b> to continue.</p>' +
    '</div></div>';
  throw new Error('secondary display backdrop');
}

(async () => {
  const ctx = await window.agent.getContext();
  if (ctx.employee) {
    $('who').textContent = `${ctx.employee.name} · ${ctx.employee.emp_id}`;
    // Pre-fill the username so the right employee just types their password.
    $('username').value = ctx.employee.emp_id;
    $('password').focus();
  }
})();

function tick() {
  $('clock').textContent = new Date().toLocaleString();
}
tick(); setInterval(tick, 1000);

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('error').textContent = '';
  const btn = $('submit');
  btn.disabled = true; btn.textContent = 'Verifying…';
  try {
    const r = await window.agent.reauth({
      username: $('username').value.trim(),
      password: $('password').value,
    });
    if (!r.ok) throw new Error(r.error || 'Authentication failed');
    // success: main process destroys this window.
  } catch (err) {
    $('error').textContent = err.message;
    $('password').value = '';
    $('password').focus();
  } finally {
    btn.disabled = false; btn.textContent = 'Unlock & resume';
  }
});

// Block common escape shortcuts inside the lock window.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || (e.altKey && e.key === 'F4') || (e.key === 'F11')) {
    e.preventDefault();
  }
}, true);
