require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const agentRoutes = require('./routes/agent');
const adminRoutes = require('./routes/admin');
const portalRoutes = require('./routes/portal');

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

// Health check (used by agents to confirm the server is reachable).
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'device-logger', time: new Date().toISOString() }));

app.use('/api/agent', agentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/portal', portalRoutes);

// Static assets (shared CSS, both portal apps).
app.use(express.static(path.join(__dirname, '..', 'public')));
// Employee portal (role-based: employee / TL / reporting manager).
app.get(['/portal', '/portal/*'], (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'portal.html')));
// Admin portal (everything else).
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const PORT = Number(process.env.PORT) || 4000;
const server = app.listen(PORT, () => {
  console.log(`Device Logger server listening on http://0.0.0.0:${PORT}`);
  console.log(`Admin portal:  http://localhost:${PORT}/`);
  console.log(`Agent API:     http://localhost:${PORT}/api/agent`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n✗ Port ${PORT} is already in use — the server is probably already running.`);
    console.error(`  Open the portal at http://localhost:${PORT}/ , or set a different port:`);
    console.error(`      PORT=4001 npm start`);
    console.error(`  To stop the process using the port:  fuser -k ${PORT}/tcp   (Linux)`);
  } else {
    console.error('✗ Server failed to start:', err.message);
  }
  process.exit(1);
});
