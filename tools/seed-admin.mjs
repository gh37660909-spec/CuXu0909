/**
 * Seed the local admin account.
 *
 *   node tools/seed-admin.mjs <data-dir> <username> <password> [nickname]
 *
 * Writes data/account.json with a scrypt hash and role "admin". Existing
 * profile data is kept; only a missing profile gets a nickname default.
 * Restart the server afterwards: the account is loaded once at startup.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const [dataDirArg, username, password, nickname] = process.argv.slice(2);
if (!dataDirArg || !username || !password) {
  console.error('usage: node tools/seed-admin.mjs <data-dir> <username> <password> [nickname]');
  process.exit(2);
}
if (password.length < 8) {
  console.error('password must be at least 8 characters');
  process.exit(2);
}

const dataDir = path.resolve(dataDirArg);
await fs.mkdir(dataDir, { recursive: true });

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 32).toString('hex');
await fs.writeFile(path.join(dataDir, 'account.json'), JSON.stringify({
  username,
  salt,
  hash,
  role: 'admin',
  createdAt: Date.now()
}, null, 2), 'utf8');

const profilePath = path.join(dataDir, 'profile.json');
let profileExists = true;
try { await fs.access(profilePath); } catch { profileExists = false; }
if (!profileExists) {
  await fs.writeFile(profilePath, JSON.stringify({
    nickname: nickname || username,
    birthDate: '',
    gender: 'private',
    avatar: '',
    updatedAt: Date.now()
  }, null, 2), 'utf8');
}

console.log(JSON.stringify({ ok: true, dataDir, username, role: 'admin', profile: profileExists ? 'kept' : 'created' }));
