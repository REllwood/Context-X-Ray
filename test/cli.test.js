import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliScript = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const fixture = fileURLToPath(new URL('../fixtures/repeated-context.json', import.meta.url));

function runCli(argumentsList, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliScript, ...argumentsList], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

test('reads multi-byte characters from standard input without corrupting chunk boundaries', async () => {
  const content = `x${'€'.repeat(200_000)}`;
  const { code, stdout } = await runCli([], JSON.stringify({ version: 1, segments: [{ id: 'euro', content }] }));
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.totals.characters, content.length);
  assert.equal(report.totals.bytes, 1 + 200_000 * 3);
});

test('accepts options before or after the bundle path and rejects unknown options', async () => {
  for (const argumentsList of [['--include-excerpts', fixture], [fixture, '--include-excerpts']]) {
    const { code, stdout } = await runCli(argumentsList);
    assert.equal(code, 0);
    const report = JSON.parse(stdout);
    assert.equal(report.excerptsIncluded, true);
    assert.equal(typeof report.segments[0].excerpt, 'string');
  }
  const unknown = await runCli(['--nonsense', fixture]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown option '--nonsense'/);
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage:/);
});
