// Creates .env from .env.example on first run (never overwrites an existing one).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const env = path.join(root, '.env');
const example = path.join(root, '.env.example');

if (fs.existsSync(env)) {
  console.log('• .env already exists — keeping it.');
} else {
  fs.copyFileSync(example, env);
  console.log('• Created .env from .env.example — edit it to set your DB + admin credentials.');
}
