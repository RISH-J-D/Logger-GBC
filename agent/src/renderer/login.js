const $ = (id) => document.getElementById(id);

// Secondary monitors show a backdrop only — the form lives on the primary.
if (location.hash === '#secondary') {
  document.body.innerHTML =
    '<div class="login"><div class="card" style="text-align:center">' +
    '<div class="brand" style="justify-content:center"><span class="logo">🔒</span> Struzon Monitor</div>' +
    '<h1>This device is locked</h1>' +
    '<p class="sub muted">Please sign in on the <b>main screen</b> to unlock the computer.</p>' +
    '</div></div>';
  throw new Error('secondary display backdrop'); // stop the rest of login.js
}

(async () => {
  const ctx = await window.agent.getContext();
  $('server').value = ctx.serverUrl || '';
  $('ctx').textContent = `Device: ${ctx.hostname} · Server: ${ctx.serverUrl}`;
  // Load the searchable project/task list from the server (typeahead).
  try {
    const projects = await window.agent.getProjects();
    const list = $('project-list');
    for (const name of projects || []) {
      const o = document.createElement('option');
      o.value = name;
      list.appendChild(o);
    }
  } catch {}
})();

$('toggle-server').addEventListener('click', () => {
  $('server-row').classList.toggle('show');
});

$('server').addEventListener('change', async (e) => {
  const url = e.target.value.trim();
  if (url) {
    const saved = await window.agent.saveServerUrl(url);
    $('ctx').textContent = `Server set to ${saved}`;
  }
});

// Block common escape / close shortcuts while the machine is gated.
window.addEventListener('keydown', (e) => {
  const k = e.key;
  if (k === 'Escape' || k === 'F11' || k === 'Meta' ||
      (e.altKey && (k === 'F4' || k === 'Tab')) ||
      (e.ctrlKey && k === 'w') || (e.ctrlKey && k === 'r')) {
    e.preventDefault();
  }
}, true);

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('error').textContent = '';
  const btn = $('submit');
  btn.disabled = true; btn.textContent = 'Signing in…';

  try {
    const username = $('username').value.trim();
    let password = $('password').value;
    let project = $('project').value;
    if (project === '__other__') project = $('project-other').value.trim();
    if (!project) throw new Error('Please select what you are working on');

    const isChangingPassword = $('change-password-section').style.display === 'block';

    if (isChangingPassword) {
      const newPwd = $('new-password').value;
      const confPwd = $('confirm-password').value;
      if (!newPwd) throw new Error('Please enter a new password');
      if (newPwd !== confPwd) throw new Error('Passwords do not match');

      btn.textContent = 'Changing Password…';
      const changeRes = await window.agent.changePassword({ username, old_password: password, new_password: newPwd });
      if (!changeRes.ok) throw new Error(changeRes.error || 'Failed to change password');
      
      // Successfully changed, update the password we use to login
      password = newPwd;
      $('password').value = newPwd;
      btn.textContent = 'Signing in…';
    }

    const r = await window.agent.login({ username, password, project });
    
    if (r.require_password_change) {
      $('change-password-section').style.display = 'block';
      $('project-label').style.display = 'none';
      $('project').style.display = 'none';
      $('project-other').style.display = 'none';
      btn.textContent = 'Change Password & Sign in';
      $('new-password').required = true;
      $('confirm-password').required = true;
      throw new Error('You must change your password before continuing.');
    }

    if (!r.ok) throw new Error(r.error || 'Login failed');
    // success: main process hides this window and starts monitoring.
    $('error').className = 'ok';
    $('error').textContent = `Welcome, ${r.employee.name}. Monitoring started.`;
  } catch (err) {
    $('error').className = 'error';
    $('error').textContent = err.message;
    if ($('change-password-section').style.display === 'block') {
      btn.textContent = 'Change Password & Sign in';
    } else {
      btn.textContent = 'Sign in & start monitoring';
    }
  } finally {
    btn.disabled = false;
  }
});
