import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');

test('source edits discard stale analysis before comparison or export', () => {
  assert.match(appSource, /function discardAnalysis\(/);
  assert.match(
    appSource,
    /elements\.source\.addEventListener\('input',[\s\S]*?discardAnalysis\(/
  );
  assert.match(appSource, /currentBundle = null/);
  assert.match(appSource, /currentAnalysis = null/);
  assert.match(appSource, /elements\.analysis\.hidden = true/);
  assert.match(appSource, /if \(!currentAnalysis\)/);
  assert.match(appSource, /if \(!currentBundle\)/);
});
