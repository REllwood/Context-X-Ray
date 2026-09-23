import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverScript = fileURLToPath(new URL('../server.mjs', import.meta.url));

async function startServer(t, script = serverScript) {
  const child = spawn(process.execPath, [script, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const origin = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) resolve(match[0]);
    });
    child.once('exit', (code) => reject(new Error(`Server exited with code ${code}.`)));
  });
  return { child, origin };
}

test('serves the allow-listed files with a restrictive content security policy', async (t) => {
  const { origin } = await startServer(t);
  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.match(await page.text(), /<title>Context X-Ray<\/title>/);
  const script = await fetch(`${origin}/src/core.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /^text\/javascript/);
  const head = await fetch(`${origin}/`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('rejects unknown paths, malformed paths and other methods', async (t) => {
  const { origin } = await startServer(t);
  assert.equal((await fetch(`${origin}/server.mjs`)).status, 404);
  assert.equal((await fetch(`${origin}/src/../server.mjs`)).status, 404);
  assert.equal((await fetch(`${origin}/%E0%A4%A`)).status, 400);
  const post = await fetch(`${origin}/`, { method: 'POST', body: 'x' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
});

test('a missing public file returns 404 without stopping the server', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'context-xray-server-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'server.mjs');
  await copyFile(serverScript, script);
  const { child, origin } = await startServer(t, script);
  assert.equal((await fetch(`${origin}/`)).status, 404);
  assert.equal((await fetch(`${origin}/src/app.js`)).status, 404);
  assert.equal(child.exitCode, null);
});
