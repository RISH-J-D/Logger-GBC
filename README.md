# Struzon Device Usage Monitoring

A complete, self-hosted system that monitors employee device usage:

- **Records login time** when an employee signs in on a monitored machine.
- **Detects 5 minutes of inactivity** (no mouse / keyboard) and throws a
  fullscreen **lock screen**.
- **Re-authentication**: when activity resumes, the employee must re-enter their
  Employee ID + password to continue. Only the employee who owns the session can
  unlock it.
- **Auto-start on computer login**: once installed, the agent launches itself
  whenever the user logs into Windows/Linux and pops up the sign-in automatically
  — nothing to open manually.
- **Remote stop/resume from the portal**: the admin can stop monitoring a
  specific employee with one click. That employee instantly gets a *"You are out
  of monitoring"* pop-up and tracking halts. Pressing resume asks them to sign in
  again.
- **Everything is stored** in a central PostgreSQL database.
- **Admin portal** (blue & white) to monitor every employee, with a calendar,
  search by name / Emp ID / team, per-session detail, and a full event trail.

Employee credentials are taken from the login-info PDFs in
`Employee_LoginInfo_PDFs/` (183 employees, e.g. `saravanan.s` / `Stru@123` =
`STZ002`).

```
 ┌────────────────────┐        HTTP         ┌──────────────────────────┐
 │  Desktop Agent      │  login / heartbeat  │   Central Server         │
 │  (Windows .exe /    │ ──idle-lock/reauth─▶│   Express API + Portal   │
 │   Linux .deb)       │      logout         │                          │
 └────────────────────┘                     │            │             │
                                             │            ▼             │
 ┌────────────────────┐        HTTP          │     PostgreSQL DB        │
 │  Admin (browser)    │ ◀──monitor logs────│                          │
 └────────────────────┘                     └──────────────────────────┘
```

---

## Repository layout

```
logger/
├── server/                     Central server (REST API + admin portal)
│   ├── src/                     Express app, DB layer, auth, routes
│   ├── public/                  Admin portal (HTML/CSS/JS)
│   ├── scripts/                 migrate / import-employees / seed-demo
│   ├── data/employees.seed.json 183 employees parsed from the PDFs
│   └── docker-compose.yml       Optional Postgres for quick setup
├── agent/                      Desktop monitoring agent (Electron)
│   ├── src/                     main process, preload, login + lock UIs
│   ├── build/icon.png           App icon
│   ├── config.json              Default agent config (server URL, 5-min idle)
│   └── package.json             electron-builder config (nsis + deb)
├── tools/parse_pdfs.py         Re-generates employees.seed.json from the PDFs
└── Employee_LoginInfo_PDFs/    Source credential cards (input data)
```

---

## Part 1 — Central server + database

Run this once, on a machine/VM all the employee computers can reach over the
network (e.g. `http://192.168.1.50:4000`).

### Prerequisites
- Node.js 18+ and npm
- PostgreSQL 14+ (or use the bundled `docker-compose.yml`)

### One command (recommended)

```bash
cd server && npm run bootstrap
```

`bootstrap` does everything: `npm install` → create `.env` (first run only) →
create tables → import the 183 employees → start the server. Re-run it any time;
every step is idempotent.

To also auto-start the **bundled PostgreSQL** in the same command, use the
wrapper script:

```bash
cd server && START_DB=1 ./start.sh      # Linux / macOS
cd server && set START_DB=1 && start.bat  # Windows
```

> Edit `server/.env` (DB URL, `ADMIN_USERNAME` / `ADMIN_PASSWORD`, `JWT_SECRET`,
> optional `AGENT_API_KEY`) before first run — `bootstrap` creates it from
> `.env.example` but won't overwrite an existing one. If you change DB/admin
> settings later, just run `npm run bootstrap` again.

### Steps (manual equivalent)

```bash
cd server
npm install
docker compose up -d              # or point .env at your own Postgres
cp .env.example .env              # then edit DB + admin credentials
npm run setup                     # migrate + import the 183 employees
npm start
```

Server is now at `http://<server-ip>:4000`:
- Admin portal: `http://<server-ip>:4000/`
- Agent API:    `http://<server-ip>:4000/api/agent`

> **Re-import / refresh employees** after editing the PDFs:
> `python3 tools/parse_pdfs.py && (cd server && npm run import-employees)`
> Importing is idempotent (matched by Emp ID); it never deletes session history.

### Admin portal

Open `http://<server-ip>:4000/` and sign in with `ADMIN_USERNAME` /
`ADMIN_PASSWORD`. You get:

- **Dashboard** — employees, active sessions, logins today, currently locked.
- **Search** — by name, Emp ID, device username or team.
- **Per-employee view** — activity **calendar** (🔑 = sessions, 🔒 = idle locks;
  click a day to filter), **login sessions** table (login/logout/duration/host),
  and a **session event trail** (login → idle lock → re-auth → logout).
- **Date range** filters.

To see the portal populated immediately with sample data:
`cd server && node scripts/seed-demo.js` (safe to delete; demo only).

---

## Part 2 — Desktop agent (installed on each computer)

### Run from source (development)

```bash
cd agent
npm install
DEVICE_LOGGER_SERVER=http://<server-ip>:4000 npm start
```

### Build the installers

The icon, app id and targets are already configured in `agent/package.json`.

**Windows `.exe` (NSIS installer):**
```bash
cd agent
npm run dist:win
# -> agent/release/Struzon Monitor Setup 1.0.0.exe
```

**Linux `.deb`:**
```bash
cd agent
npm run dist:linux
# -> agent/release/struzon-monitor-agent_1.0.0_amd64.deb
```

> Building the **Windows** `.exe` on Linux requires `wine`
> (`sudo apt install wine`). It also builds natively on Windows.
> Building the **`.deb`** works on any Linux box. `npm run dist` builds both.

### Install

**Windows:** double-click `Struzon Monitor Setup 1.0.0.exe` → choose folder →
Finish. Installs to Program Files, adds Start-menu + desktop shortcuts.

**Linux (Debian/Ubuntu):**
```bash
sudo apt install ./struzon-monitor-agent_1.0.0_amd64.deb
# launch (as your normal user, NOT sudo):
struzon-monitor-agent
#   ...or launch "Struzon Monitor" from the applications menu.
```

### Point the agent at your server

Each agent needs the central server URL. Any of these (highest priority first):

1. **On the login screen** → "Server settings" → enter `http://<server-ip>:4000`
   (saved per machine).
2. **Environment variable** `DEVICE_LOGGER_SERVER=http://<server-ip>:4000`.
3. **Bundled default** in `agent/config.json` *before building* — set
   `serverUrl` (and `agentKey` if you enabled `AGENT_API_KEY`) so every installer
   ships pre-configured.

```json
{ "serverUrl": "http://192.168.1.50:4000", "idleTimeoutSeconds": 300, "agentKey": "" }
```

### Auto-start on login

The agent registers itself to **launch automatically when the user logs into the
computer** (no manual step needed):

- **Windows:** adds a per-user login item (registry `Run` key) on first launch.
- **Linux:** writes `~/.config/autostart/struzon-monitor-agent.desktop` on first
  launch.

So after install, the sign-in window appears on every OS login by itself.

---

## How it works

1. On OS login the agent auto-starts and throws a **fullscreen sign-in gate** on
   every display — the desktop is blocked and unusable until the employee enters
   a valid Emp ID/username + password. On success the gate disappears and the
   machine becomes usable; the agent `POST /api/agent/login` records the **login
   time** and starts a session.
2. Agent polls the OS idle time every few seconds and sends heartbeats.
3. After **5 minutes** with no mouse/keyboard input → agent `POST
   /api/agent/idle-lock`, sets the session **locked**, and shows the fullscreen
   lock window on every display.
4. Any activity lands on the lock screen, which requires the employee’s Emp ID +
   password → `POST /api/agent/reauth`. A wrong password or a *different*
   employee is rejected and logged; a correct one resumes monitoring.
5. Closing the app / shutting down → `POST /api/agent/logout` ends the session.

The 5-minute threshold is `idleTimeoutSeconds` in `agent/config.json` (300).

### Remote stop / resume

In the portal, open an employee and use the **Stop monitoring** button (top
right). The server flags that employee and ends their live session; on the next
heartbeat (seconds) the agent shows a fullscreen **"You are out of monitoring"**
pop-up and stops tracking. The button becomes **Resume monitoring** — pressing it
makes the agent show the sign-in again so the employee can resume. Both actions
are recorded in the employee's event trail (`monitoring_stopped` /
`monitoring_resumed`).

---

## Security notes

- Employee passwords are stored **bcrypt-hashed**; the PDFs’ plaintext is only
  read once at import time.
- All 183 employees currently share the default password `Stru@123`. Change them
  by updating the PDFs (or the DB) and re-importing.
- Set a strong `JWT_SECRET` and admin password in `server/.env`.
- Optionally set `AGENT_API_KEY` in `.env` **and** in each agent’s config so only
  your agents can post to the API.
- Put the server behind HTTPS (e.g. a reverse proxy) for production.

## Troubleshooting

**Linux: app crashes on launch with `failed to execvp` / `zygote_host... Check
failed` / `SUID sandbox`.** Ubuntu 24.04+ restricts unprivileged user namespaces
(`kernel.apparmor_restrict_unprivileged_userns = 1`), which breaks Electron's
Chromium sandbox. The `.deb` already works around this (it launches with
`--no-sandbox` via a wrapper). If you hit it running an older build or from
source, launch with the flag:
`struzon-monitor-agent --no-sandbox`  (or `npm start`, which includes it).

## Limitations / notes

- Idle detection uses the OS system-idle timer (Electron `powerMonitor`), which
  covers mouse + keyboard. On Linux it needs an X11 session (Wayland may not
  report idle time).
- **Sign-in gate / lock strength:** the sign-in gate and idle lock are strong
  fullscreen, always-on-top, kiosk windows on every display that block the
  desktop and swallow common escape shortcuts (Esc, Alt+F4, Alt+Tab, F11,
  Ctrl+W/R). This makes the machine unusable until authentication. It is an
  application-level gate, **not** a kernel-level OS login replacement — a user
  with physical access could still switch to a text console (Ctrl+Alt+F2 on
  Linux) or kill the process from another account. For tamper-proof, true
  "can't-touch-the-OS-until-auth" enforcement you must integrate with the OS
  login stack (a **PAM** module on Linux, a **Credential Provider** on Windows);
  that is a separate, OS-level project and can be added on request.
- `agent/src/main.js` has a test-only idle simulator behind
  `DEVICE_LOGGER_TEST_IDLE=1` (used to verify the lock flow without waiting/idling
  a real machine). It has no effect unless that env var is set.
```
