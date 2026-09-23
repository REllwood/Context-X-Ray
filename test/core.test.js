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

test('Anthropic-style tool use and tool results are measured and grouped by tool name', () => {
  const fileText = 'export function retryPayment() {}\n'.repeat(40);
  const analysis = analyseBundle({
    messages: [
      { role: 'user', content: 'Why does the retry fail?' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private reasoning that must not be measured', signature: 'x' },
          { type: 'text', text: 'Reading the file.' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'src/payment.js' } }
        ]
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: fileText },
          { type: 'tool_result', tool_use_id: 'toolu_missing', content: [{ type: 'text', text: 'second' }, { type: 'image', source: {} }], is_error: true }
        ]
      }
    ]
  });
  assert.deepEqual(analysis.segments.map(({ id }) => id), [
    'message-1',
    'message-2',
    'message-2:tool-call-1',
    'message-3:tool-result-1',
    'message-3:tool-result-2'
  ]);
  const byId = new Map(analysis.segments.map((segment) => [segment.id, segment]));
  assert.equal(byId.get('message-2:tool-call-1').source, 'tool-call:read_file');
  assert.equal(byId.get('message-2:tool-call-1').content, '{"path":"src/payment.js"}');
  assert.equal(byId.get('message-3:tool-result-1').source, 'tool-result:read_file');
  assert.equal(byId.get('message-3:tool-result-1').measurement.characters, fileText.length);
  assert.equal(byId.get('message-3:tool-result-2').source, 'tool-result:unknown');
  assert.match(byId.get('message-3:tool-result-2').transformation, /error/);
  assert.ok(analysis.sources.some(({ source }) => source === 'tool-result:read_file'));
  assert.equal(JSON.stringify(analysis).includes('private reasoning'), false);
  assert.deepEqual(analysis.findings.importWarnings, [
    'Message 2 has content that was not measured and is represented by metadata only: 1 thinking block.',
    'Message 3 has content that was not measured and is represented by metadata only: 1 image block.'
  ]);
});

test('OpenAI-style tool calls and tool messages are measured and grouped by tool name', () => {
  const analysis = analyseBundle({
    messages: [
      { role: 'user', content: 'Find the retry code.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'grep', arguments: '{"pattern":"retry"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'src/payment.js:12: retryPayment()' }
    ]
  });
  assert.deepEqual(analysis.segments.map(({ id, source, stage }) => [id, source, stage]), [
    ['message-1', 'message:1', 'conversation'],
    ['message-2:tool-call-1', 'tool-call:grep', 'tool call'],
    ['message-3', 'tool-result:grep', 'tool result']
  ]);
  assert.equal(analysis.segments[1].content, '{"pattern":"retry"}');
  assert.deepEqual(analysis.findings.importWarnings, []);
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

test('parsed bundles are analysed once, so parse-then-analyse keeps every reference and warning', () => {
  const references = (prefix) => Array.from({ length: 50 }, (_, index) => `${prefix}-${index}.js`);
  const manyReferences = {
    version: 1,
    segments: ['a', 'b', 'c'].map((id) => ({ id, content: id, references: references(id) }))
  };
  const analysed = analyseBundle(parseBundle(JSON.stringify(manyReferences)));
  assert.equal(analysed.findings.unresolvedReferences.length, 150);

  const saved = JSON.stringify(normaliseBundle(manyReferences));
  assert.equal(analyseBundle(parseBundle(saved)).findings.unresolvedReferences.length, 150);

  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const messages = Array.from({ length: 120 }, (_, index) => ({ role: 'user', content: [{ type: 'text', text: `turn ${index}` }, image, image] }));
  const parsed = parseBundle(JSON.stringify({ messages }));
  const analysis = analyseBundle(parsed);
  assert.equal(analysis.adapter, 'chat messages export');
  assert.deepEqual(analysis.findings.importWarnings, parsed.importWarnings);
});

test('normalised bundles are frozen and caller-supplied adapter labels are not trusted', () => {
  const normalised = normaliseBundle(bundle);
  assert.equal(Object.isFrozen(normalised.segments[0]), true);
  assert.throws(() => normalised.segments.push({}), TypeError);
  const spoofed = analyseBundle({
    ...bundle,
    tokeniser: 'estimate:utf8-bytes-divided-by-4:v1',
    adapter: 'invented adapter',
    importWarnings: ['invented warning']
  });
  assert.equal(spoofed.adapter, 'context-xray bundle v1');
  assert.deepEqual(spoofed.findings.importWarnings, []);
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

test('near duplicates link each segment to its most similar earlier segment', () => {
  const words = Array.from({ length: 60 }, (_, index) => `word${index}`);
  const segments = Array.from({ length: 30 }, (_, index) => {
    const variant = words.slice();
    variant[index % 60] = `edit${index}`;
    return { id: `s${index}`, content: variant.join(' ') };
  });
  const near = analyseBundle({ version: 1, segments }).findings.nearDuplicates;
  assert.equal(near.length, 29);
  near.forEach(({ segmentIds: [earlier, later] }) => {
    assert.ok(Number(earlier.slice(1)) < Number(later.slice(1)));
  });
  const copies = analyseBundle({ version: 1, segments: [segments[0], { ...segments[0], id: 'copy' }, segments[1]] }).findings;
  assert.deepEqual(copies.exactDuplicates[0].segmentIds, ['s0', 'copy']);
  assert.deepEqual(copies.nearDuplicates.map(({ segmentIds }) => segmentIds), [['s0', 's1']]);
});

test('segments without words are not reported as near duplicates of each other', () => {
  const analysis = analyseBundle({
    version: 1,
    segments: [{ id: 'rule', content: '='.repeat(45) }, { id: 'emoji', content: `${'🙂'.repeat(25)}${'!'.repeat(20)}` }]
  });
  assert.deepEqual(analysis.findings.nearDuplicates, []);
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
