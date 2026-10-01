const $ = (id) => document.getElementById(id);

$('reason').addEventListener('change', () => {
  $('note').placeholder = $('reason').value === 'other'
    ? 'Please describe (required for Other)' : 'Add a note (optional)';
});

$('cancel').addEventListener('click', () => window.agent.cancelLogout());

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const reason = $('reason').value;
  const note = $('note').value.trim();
  if (!reason) { $('error').textContent = 'Please select a reason'; return; }
  if (reason === 'other' && !note) { $('error').textContent = 'Please add a note for "Other"'; return; }
  await window.agent.confirmLogout({ reason, note });
});
