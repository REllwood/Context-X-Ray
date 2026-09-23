import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyseBundle,
  compareBundles,
  exportAnalysis,
  MAX_REFERENCES,
  MAX_SEGMENT_CHARACTERS,
  MAX_SEGMENTS,
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

test('characters are counted as code points in limits, offsets and excerpts', () => {
  const emoji = '🙂';
  assert.equal(normaliseBundle({ version: 1, segments: [{ id: 'e', content: emoji.repeat(MAX_SEGMENT_CHARACTERS) }] }).segments[0].content.length, MAX_SEGMENT_CHARACTERS * 2);
  assert.throws(() => normaliseBundle({ version: 1, segments: [{ id: 'e', content: emoji.repeat(MAX_SEGMENT_CHARACTERS + 1) }] }), /exceeds/);

  const token = `ghp_${'A'.repeat(36)}`;
  const analysis = analyseBundle({ version: 1, segments: [{ id: 's', content: `${emoji}${emoji} ${token}` }] });
  assert.deepEqual([analysis.findings.secretWarnings[0].offset, analysis.findings.secretWarnings[0].length], [3, 40]);

  const excerptSource = analyseBundle({ version: 1, segments: [{ id: 'x', content: `${'a'.repeat(499)}${emoji}b` }] });
  const [segment] = JSON.parse(exportAnalysis(excerptSource, 'json', { includeExcerpts: true })).segments;
  assert.equal(segment.excerpt, `${'a'.repeat(499)}${emoji}`);
});

test('normalisation supports a common messages export and bounds unsupported shapes', () => {
  const result = normaliseBundle({ label: 'Messages', messages: [{ role: 'user', content: 'Hello' }] });
  assert.equal(result.adapter, 'chat messages export');
  assert.equal(result.segments[0].content, 'Hello');
  assert.equal(analyseBundle(result).adapter, 'chat messages export');
  assert.throws(() => parseBundle('{bad json}'), /not valid JSON/i);
  assert.throws(() => normaliseBundle({ unknown: [] }), /Unsupported bundle shape/);
});

test('system prompts given as content blocks are measured, and unsupported ones are reported', () => {
  const prompt = 'You are a careful coding agent. '.repeat(50);
  const blocks = analyseBundle({
    system: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'Be brief.' }, { type: 'image', source: {} }],
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.equal(blocks.adapter, 'system-plus-messages export');
  assert.deepEqual(blocks.segments.map(({ id, role }) => [id, role]), [['system-1', 'system'], ['message-1', 'user']]);
  assert.equal(blocks.segments[0].content, `${prompt}\n\nBe brief.`);
  assert.deepEqual(blocks.findings.importWarnings, ['The system field has content that was not measured and is represented by metadata only: 1 image block.']);

  const unsupported = analyseBundle({ system: { text: prompt }, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(unsupported.adapter, 'chat messages export');
  assert.deepEqual(unsupported.segments.map(({ id }) => id), ['message-1']);
  assert.match(unsupported.findings.importWarnings[0], /^The system field .* 1 unsupported content field\.$/);
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

test('long agent transcripts fit within the segment limit, which is still enforced', () => {
  const messages = [];
  for (let turn = 0; turn < 120; turn += 1) {
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `Step ${turn}` }, { type: 'tool_use', id: `t${turn}`, name: 'read_file', input: { path: `f${turn}.js` } }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${turn}`, content: `contents of file ${turn} `.repeat(200) }] });
  }
  const analysis = analyseBundle(parseBundle(JSON.stringify({ messages })));
  assert.equal(analysis.segments.length, 360);
  assert.throws(
    () => normaliseBundle({ version: 1, segments: Array.from({ length: MAX_SEGMENTS + 1 }, (_, index) => ({ id: `s${index}` })) }),
    new RegExp(`limited to ${MAX_SEGMENTS} segments`)
  );
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
      references: Array.from({ length: MAX_REFERENCES + 1 }, (_, index) => `file-${index}.js`)
    }),
    new RegExp(`references.*at most ${MAX_REFERENCES}`, 'i')
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

test('common credential formats are flagged without copying the matched text', () => {
  // Built at run time so no credential-shaped literal appears in the source.
  const fake = (prefix, length, character = 'A') => `${prefix}${character.repeat(length)}`;
  const samples = {
    'GitHub-style token pattern': fake('ghp_', 36),
    'GitHub fine-grained token pattern': fake('github_pat_', 82),
    'Anthropic API key pattern': fake('sk-ant-api03-', 93),
    'OpenAI API key pattern': fake('sk-proj-', 48),
    'Slack token pattern': fake('xoxb-', 40, '1'),
    'Stripe live secret key pattern': fake('sk_live_', 24),
    'Google API key pattern': fake('AIza', 35),
    'Private key header': ['-----BEGIN', 'ENCRYPTED', 'PRIVATE', 'KEY-----'].join(' ')
  };
  const analysis = analyseBundle({
    version: 1,
    segments: Object.values(samples).map((content, index) => ({ id: `secret-${index}`, content: `value: ${content}\n` }))
  });
  assert.deepEqual(analysis.findings.secretWarnings.map(({ type }) => type), Object.keys(samples));
  for (const value of Object.values(samples)) assert.equal(JSON.stringify(analysis.findings).includes(value), false);
  const plain = analyseBundle({ version: 1, segments: [{ id: 'prose', content: 'The task-ant-colony and risk-management notes mention xoxo and AIza.' }] });
  assert.deepEqual(plain.findings.secretWarnings, []);
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
  assert.deepEqual(comparison.reordered, ['copy-a']);
  assert.match(comparison.method, /no model call or semantic judgement/i);
});

test('bundle comparison reports only segments whose relative order changed', () => {
  const ordered = (ids) => ({ version: 1, segments: ids.map((id) => ({ id, content: `content for ${id}` })) });
  const base = ordered(['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(compareBundles(base, ordered(['a', 'c', 'd', 'e'])).reordered, []);
  assert.deepEqual(compareBundles(base, ordered(['new', 'a', 'b', 'c', 'd', 'e'])).reordered, []);
  assert.deepEqual(compareBundles(base, ordered(['e', 'a', 'b', 'c', 'd'])).reordered, ['e']);
  assert.deepEqual(compareBundles(base, ordered(['b', 'c', 'd', 'e', 'a'])).reordered, ['a']);
  assert.deepEqual(compareBundles(base, ordered(['e', 'd', 'c', 'b', 'a'])).reordered.length, 4);
});
