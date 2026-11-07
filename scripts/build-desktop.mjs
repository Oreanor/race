/**
 * Next static export for Tauri. API routes are incompatible with `output: 'export'`,
 * so their `route.ts` files are temporarily renamed for this build only.
 */
import { readdir, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiRoot = path.join(root, 'src', 'app', 'api');
const BAK = '.desktop-bak';

async function listRouteFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listRouteFiles(full)));
    else if (entry.name === 'route.ts' || entry.name === 'route.js') out.push(full);
  }
  return out;
}

async function run(cmd, args, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, env, stdio: 'inherit', shell: true });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

const routes = await listRouteFiles(apiRoot);
const stashed = [];
try {
  for (const file of routes) {
    const bak = file + BAK;
    await rename(file, bak);
    stashed.push([file, bak]);
  }
  await run('npx', ['next', 'build', '--webpack'], {
    ...process.env,
    TAURI: '1',
    NEXT_TELEMETRY_DISABLED: '1',
  });
} finally {
  for (const [file, bak] of stashed) {
    try {
      await rename(bak, file);
    } catch (err) {
      console.error(`failed to restore ${file}:`, err);
    }
  }
}
