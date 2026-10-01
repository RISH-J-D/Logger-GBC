// electron-builder afterPack hook (Linux only).
//
// Ubuntu 24.04+ restricts unprivileged user namespaces via AppArmor, which
// breaks Electron's Chromium sandbox at startup (zygote FATAL / "failed to
// execvp"). The Chromium sandbox switch must be set on the command line BEFORE
// the JS main runs, so we can't do it from inside main.js. Instead we replace
// the packaged executable with a tiny wrapper that re-launches the real binary
// with --no-sandbox. Disabling the Chromium sandbox is the standard, accepted
// workaround for an internal line-of-business desktop app.
const fs = require('fs');
const path = require('path');

const EXE = 'struzon-monitor-agent';   // must match package.json "name"

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;

  const dir = context.appOutDir;
  const exePath = path.join(dir, EXE);
  const realPath = path.join(dir, `${EXE}-bin`);

  if (!fs.existsSync(exePath) || fs.existsSync(realPath)) return; // already wrapped

  fs.renameSync(exePath, realPath);
  fs.writeFileSync(
    exePath,
    `#!/bin/bash
# Auto-generated launcher: run the real Electron binary without the Chromium
# sandbox (required on Ubuntu 24.04+ where unprivileged user namespaces are
# restricted by AppArmor).
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/${EXE}-bin" --no-sandbox "$@"
`
  );
  fs.chmodSync(exePath, 0o755);
  console.log(`  • afterPack: wrapped ${EXE} with --no-sandbox launcher`);
};
