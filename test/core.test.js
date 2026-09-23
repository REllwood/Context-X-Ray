import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyseBundle,
  compareBundles,
  exportAnalysis,
  measureContent,
  normaliseBundle,
  parseBundle
} from '../src/core.js';

const bundle = {
  version: 1,
  label: 'Synthetic bundle',
  references: [{ path: '/workspace/not-included.js', fromSegmentId: 'task' }],
  segments: [
    { id: 'task', role: 'user', source: 'conversation', stage: 'conversation', content: 'Inspect the supplied synthetic source.' },
    { id: 'copy-a', role: 'tool', source: 'a.js', stage: 'retrieval', content: 'export function calculateRetry(value) { return value + 1; }\n' },
    { id: 'copy-b', role: 'tool', source: 'b.js', stage: 'retrieval', content: 'export function calculateRetry(value) { return value + 1; }\n' },
    { id: 'near', role: 'tool', source: 'summary', stage: 'summary', content: 'Export function calculate retry value and return the value plus one.' },
    { id: 'truncated', role: 'tool', source: 'target.js', stage: 'retrieval', content: 'const token = \"ghp_1234567890abcdefghijklmnop\";\n// [truncated]', truncated: true }
  ]
};

test('character, byte and token estimates are deterministic and unmistakably labelled', () => {
  assert.deepEqual(measureContent('abcd'), {
    characters: 4,
    bytes: 4,
    estimatedTokens: 1,
    tokenLabel: 'Estimated tokens',
    tokenMethod: 'UTF-8 bytes divided by 4, rounded up; not a provider tokeniser'
  });
  assert.equal(measureContent('é').bytes, 2);
  assert.match(analyseBundle(bundle).tokenMethod, /estimate, not an exact provider count/i);
});

test('normalisation supports a common messages export and bounds unsupported shapes', () => {
  const result = normaliseBundle({ label: 'Messages', messages: [{ role: 'user', content: 'Hello' }] });
  assert.equal(result.adapter, 'chat messages export');
  assert.equal(result.segments[0].content, 'Hello');
  assert.equal(analyseBundle(result).adapter, 'chat messages export');
  assert.throws(() => parseBundle('{bad json}'), /not valid JSON/i);
  assert.throws(() => normaliseBundle({ unknown: [] }), /Unsupported bundle shape/);
});

test('rejects reference overflow rather than silently dropping evidence', () => {
  assert.throws(
    () => normaliseBundle({
      version: 1,
      segments: [{
        id: 'segment',
        content: 'content',
        references: Array.from({ length: 51 }, (_, index) => `file-${index}.js`)
      }]
    }),
    /references.*at most 50/i
  );
  assert.throws(
    () => normaliseBundle({
      version: 1,
      segments: [{ id: 'segment', content: 'content' }],
      references: Array.from({ length: 201 }, (_, index) => `file-${index}.js`)
    }),
    /references.*at most 200/i
  );
});

test('exact and near duplicate evidence links exact segment identifiers', () => {
  const analysis = analyseBundle(bundle);
  assert.deepEqual(analysis.findings.exactDuplicates[0].segmentIds, ['copy-a', 'copy-b']);
  assert.equal(analysis.findings.exactDuplicates[0].similarityPercent, 100);
  assert.equal(analysis.findings.nearDuplicates.every(({ segmentIds }) => segmentIds.every((id) => analysis.segments.some((segment) => segment.id === id))), true);
  const nearAnalysis = analyseBundle({
    version: 1,
    segments: [
      { id: 'summary-a', content: 'The synthetic payment processor retries a failed charge three times before returning an error to the caller. The payment processor retries a failed charge three times before returning an error.' },
      { id: 'summary-b', content: 'The synthetic payment processor retries a failed charge three times before returning an error to the caller. The payment processor retries a failed charge three times before returning a recoverable error.' }
    ]
  });
  assert.deepEqual(nearAnalysis.findings.nearDuplicates[0].segmentIds, ['summary-a', 'summary-b']);
  assert.equal(nearAnalysis.findings.nearDuplicates[0].similarityPercent, 85.7);
});

test('references remain unresolved labels and secret findings omit matched text', () => {
  const analysis = analyseBundle(bundle);
  assert.equal(analysis.findings.unresolvedReferences[0].path, '/workspace/not-included.js');
  assert.match(analysis.findings.unresolvedReferences[0].evidence, /was not read/i);
  const secret = analysis.findings.secretWarnings[0];
  assert.equal(Object.hasOwn(secret, 'match'), false);
  assert.equal(JSON.stringify(secret).includes('ghp_1234567890abcdefghijklmnop'), false);
  assert.ok(analysis.findings.truncations.some(({ segmentId }) => segmentId === 'truncated'));
});

test('default report export excludes content and matched secret text', () => {
  const analysis = analyseBundle(bundle);
  const report = exportAnalysis(analysis, 'json');
  assert.equal(report.includes('calculateRetry(value)'), false);
  assert.equal(report.includes('ghp_1234567890abcdefghijklmnop'), false);
  assert.match(report, /\"excerptsIncluded\": false/);
  const withExcerpts = exportAnalysis(analysis, 'json', { includeExcerpts: true });
  assert.equal(withExcerpts.includes('calculateRetry(value)'), true);
});

test('Markdown exports neutralise raw HTML in imported labels and excerpts', () => {
  const hostile = analyseBundle({
    version: 1,
    label: '<img src=https://example.invalid/pixel>',
    segments: [{
      id: 'hostile',
      source: '<script>alert(1)</script>',
      content: '<img src=https://example.invalid/content>'
    }]
  });
  const markdown = exportAnalysis(hostile, 'markdown', { includeExcerpts: true });
  assert.doesNotMatch(markdown, /<script>|^<img/m);
  assert.match(markdown, /&lt;img/);
  assert.match(markdown, /^    <img src=/m);
});

test('bundle comparison reports additions, removals, changes and order without semantic claims', () => {
  const second = structuredClone(bundle);
  second.label = 'Second';
  second.segments = [second.segments[1], { ...second.segments[0], content: 'Changed task.' }, ...second.segments.slice(2, -1)];
  const comparison = compareBundles(bundle, second);
  assert.ok(comparison.removed.includes('truncated'));
  assert.ok(comparison.changed.includes('task'));
  assert.ok(comparison.reordered.includes('copy-a'));
  assert.match(comparison.method, /no model call or semantic judgement/i);
});
