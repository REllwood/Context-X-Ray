export const MAX_SEGMENTS = 200;
export const MAX_SEGMENT_CHARACTERS = 120_000;
export const MAX_TOTAL_CHARACTERS = 1_000_000;
const nearDuplicateThreshold = 0.72;
// Bundles produced by normaliseBundle are frozen and remembered here, so analysis can
// reuse them instead of validating them a second time.
const normalisedBundles = new WeakSet();

function boundedText(value, label, maximum = 500, required = false) {
  if (typeof value !== 'string') {
    if (!required && value == null) return '';
    throw new TypeError(`${label} must be text.`);
  }
  if (value.length > maximum) throw new RangeError(`${label} exceeds ${maximum.toLocaleString('en-AU')} characters.`);
  if (required && !value.trim()) throw new RangeError(`${label} cannot be empty.`);
  return value.replace(/\0/gu, '\uFFFD');
}

function boundedArray(value, label, maximum, optional = true) {
  if (value == null && optional) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  if (value.length > maximum) {
    throw new RangeError(`${label} must contain at most ${maximum} entries.`);
  }
  return value;
}

const textBlockTypes = new Set(['text', 'input_text', 'output_text']);
const toolCallBlockTypes = new Set(['tool_use', 'server_tool_use']);

function isTextBlock(block) {
  return block && typeof block === 'object' && textBlockTypes.has(block.type) && typeof block.text === 'string';
}

function serialised(value) {
  if (typeof value === 'string') return value;
  return value == null ? '' : JSON.stringify(value);
}

// Text blocks are joined; anything else is counted in `skipped` so it can be reported.
function blockText(content, skipped) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (!Array.isArray(content)) {
    skipped.set('unsupported content field', (skipped.get('unsupported content field') ?? 0) + 1);
    return '';
  }
  const parts = [];
  for (const block of content) {
    if (isTextBlock(block)) parts.push(block.text);
    else {
      const type = block && typeof block === 'object' && typeof block.type === 'string' ? `${block.type} block` : 'unrecognised block';
      skipped.set(type, (skipped.get(type) ?? 0) + 1);
    }
  }
  return parts.join('\n\n');
}

// Adapts one exported message into segments: its text, plus one segment for each tool call
// and tool result, so tool traffic is measured and grouped by tool name. Reasoning blocks,
// images and other non-text blocks are counted in an import warning but not measured.
function messageCandidates(message, index, warnings, toolNames) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new TypeError(`Message ${index + 1} must be an object.`);
  const id = message.id ?? `message-${index + 1}`;
  const skipped = new Map();
  const textBlocks = [];
  const toolSegments = [];
  const toolCounts = { 'tool-call': 0, 'tool-result': 0 };
  const addTool = (kind, fields) => {
    toolCounts[kind] += 1;
    toolSegments.push({ id: `${id}:${kind}-${toolCounts[kind]}`, role: message.role ?? 'unknown', contentType: 'text/plain', ...fields });
  };
  const recordToolName = (toolId, name) => {
    if (toolId != null) toolNames.set(String(toolId), name);
  };

  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (isTextBlock(block)) textBlocks.push(block);
      else if (block && typeof block === 'object' && toolCallBlockTypes.has(block.type)) {
        const name = typeof block.name === 'string' && block.name ? block.name : 'unknown';
        recordToolName(block.id, name);
        addTool('tool-call', {
          source: `tool-call:${name}`,
          stage: 'tool call',
          content: serialised(block.input ?? {}),
          transformation: `tool input from ${block.type} block, serialised as JSON`
        });
      } else if (block && typeof block === 'object' && block.type === 'tool_result') {
        const name = toolNames.get(String(block.tool_use_id)) ?? 'unknown';
        addTool('tool-result', {
          source: `tool-result:${name}`,
          stage: 'tool result',
          content: blockText(block.content, skipped),
          transformation: block.is_error === true ? 'tool_result block reporting an error' : 'tool_result block'
        });
      } else textBlocks.push(block);
    }
  }
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const name = typeof call?.function?.name === 'string' && call.function.name ? call.function.name : 'unknown';
      recordToolName(call?.id, name);
      addTool('tool-call', {
        source: `tool-call:${name}`,
        stage: 'tool call',
        content: serialised(call?.function?.arguments),
        transformation: 'tool_calls entry arguments'
      });
    }
  }

  const text = blockText(Array.isArray(message.content) ? textBlocks : message.content, skipped);
  const isToolMessage = message.role === 'tool' && message.tool_call_id != null;
  const toolName = isToolMessage ? toolNames.get(String(message.tool_call_id)) ?? message.name ?? 'unknown' : null;
  const candidates = [];
  if (text || toolSegments.length === 0) {
    candidates.push({
      id,
      role: message.role ?? 'unknown',
      source: isToolMessage ? `tool-result:${toolName}` : message.name ? `message:${message.name}` : `message:${index + 1}`,
      stage: isToolMessage ? 'tool result' : 'conversation',
      contentType: 'text/plain',
      content: text,
      transformation: isToolMessage ? 'adapted from tool message' : 'adapted from message export'
    });
  }
  if (skipped.size) {
    const counts = [...skipped].map(([type, count]) => `${count} ${type}${count === 1 ? '' : 's'}`);
    warnings.push(`Message ${index + 1} has content that was not measured and is represented by metadata only: ${counts.join(', ')}.`);
  }
  return [...candidates, ...toolSegments];
}

function segmentFromValue(candidate, index) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new TypeError(`Segment ${index + 1} must be an object.`);
  const content = boundedText(candidate.content ?? '', `Segment ${index + 1} content`, MAX_SEGMENT_CHARACTERS);
  return {
    id: boundedText(candidate.id ?? `segment-${index + 1}`, `Segment ${index + 1} id`, 120, true),
    role: boundedText(candidate.role ?? 'unknown', `Segment ${index + 1} role`, 50, true),
    source: boundedText(candidate.source ?? `import:${index + 1}`, `Segment ${index + 1} source`, 300, true),
    stage: boundedText(candidate.stage ?? 'assembled', `Segment ${index + 1} stage`, 100, true),
    contentType: boundedText(candidate.contentType ?? 'text/plain', `Segment ${index + 1} content type`, 100, true),
    content,
    transformation: boundedText(candidate.transformation ?? 'none declared', `Segment ${index + 1} transformation`, 300, true),
    truncated: candidate.truncated === true,
    references: boundedArray(
      candidate.references,
      `Segment ${index + 1} references`,
      50
    ).map((reference, referenceIndex) =>
      boundedText(reference, `Segment ${index + 1} reference ${referenceIndex + 1}`, 500, true)
    ),
    sensitivity: boundedText(candidate.sensitivity ?? 'unspecified', `Segment ${index + 1} sensitivity`, 80, true)
  };
}

export function normaliseBundle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('A context bundle object is required.');
  const warnings = [];
  let segments;
  let adapter;
  if (value.version === 1 && Array.isArray(value.segments)) {
    adapter = 'context-xray bundle v1';
    segments = value.segments.map(segmentFromValue);
  } else if (Array.isArray(value.messages)) {
    adapter = typeof value.system === 'string' ? 'system-plus-messages export' : 'chat messages export';
    const candidates = typeof value.system === 'string'
      ? [{ id: 'system-1', role: 'system', source: 'system', stage: 'instructions', content: value.system, transformation: 'adapted from system field' }]
      : [];
    const toolNames = new Map();
    value.messages.forEach((message, index) => {
      candidates.push(...messageCandidates(message, index, warnings, toolNames));
      if (candidates.length > MAX_SEGMENTS) throw new RangeError(`Bundles are limited to ${MAX_SEGMENTS} segments.`);
    });
    segments = candidates.map(segmentFromValue);
  } else {
    throw new RangeError('Unsupported bundle shape. Supply bundle version 1 or an object with a messages array.');
  }
  if (segments.length > MAX_SEGMENTS) throw new RangeError(`Bundles are limited to ${MAX_SEGMENTS} segments.`);
  const ids = new Set();
  let totalCharacters = 0;
  for (const segment of segments) {
    if (ids.has(segment.id)) throw new RangeError(`Duplicate segment id: ${segment.id}`);
    ids.add(segment.id);
    totalCharacters += segment.content.length;
  }
  if (totalCharacters > MAX_TOTAL_CHARACTERS) throw new RangeError(`Included content is limited to ${MAX_TOTAL_CHARACTERS.toLocaleString('en-AU')} characters.`);
  const references = new Map();
  const addReference = (reference) => references.set(`${reference.fromSegmentId}\0${reference.path}`, reference);
  boundedArray(value.references, 'Bundle references', 200).forEach((reference, index) => {
    if (typeof reference === 'string') {
      addReference({ path: boundedText(reference, `Bundle reference ${index + 1}`, 500, true), fromSegmentId: '' });
      return;
    }
    if (!reference || typeof reference !== 'object') throw new TypeError(`Bundle reference ${index + 1} must be text or an object.`);
    addReference({
      path: boundedText(reference.path, `Bundle reference ${index + 1} path`, 500, true),
      fromSegmentId: boundedText(reference.fromSegmentId ?? '', `Bundle reference ${index + 1} source id`, 120)
    });
  });
  for (const segment of segments) segment.references.forEach((path) => addReference({ path, fromSegmentId: segment.id }));
  // Counted after de-duplication, so a saved normalised bundle (whose bundle-level list
  // already repeats its segment references) can be imported again.
  if (references.size > 200) {
    throw new RangeError('Combined bundle and segment references must contain at most 200 entries.');
  }
  const bundle = deepFreeze({
    version: 1,
    label: boundedText(value.label ?? 'Untitled context bundle', 'Bundle label', 160, true),
    adapter,
    tokeniser: 'estimate:utf8-bytes-divided-by-4:v1',
    segments,
    references: [...references.values()],
    importWarnings: warnings
  });
  normalisedBundles.add(bundle);
  return bundle;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export function parseBundle(source) {
  if (typeof source !== 'string') throw new TypeError('Bundle source must be text.');
  if (source.length > 1_250_000) throw new RangeError('Bundle JSON is limited to 1,250,000 characters.');
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new SyntaxError('The context bundle is not valid JSON.');
  }
  return normaliseBundle(value);
}

export function measureContent(contentValue) {
  const content = boundedText(contentValue, 'Measured content', MAX_SEGMENT_CHARACTERS);
  const characters = [...content].length;
  const bytes = new TextEncoder().encode(content).length;
  return {
    characters,
    bytes,
    estimatedTokens: content ? Math.ceil(bytes / 4) : 0,
    tokenLabel: 'Estimated tokens',
    tokenMethod: 'UTF-8 bytes divided by 4, rounded up; not a provider tokeniser'
  };
}

function canonicalContent(content) {
  return content.normalize('NFKC').toLocaleLowerCase('en-AU').replace(/\s+/gu, ' ').trim();
}

function fingerprint(content) {
  let hash = 2166136261;
  for (const character of canonicalContent(content)) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function shingles(content) {
  const words = canonicalContent(content).match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const values = new Set();
  const width = words.length >= 3 ? 3 : 1;
  for (let index = 0; index <= words.length - width; index += 1) values.add(words.slice(index, index + width).join(' '));
  return values;
}

function similarity(left, right) {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function duplicateEvidence(segments) {
  const exactMap = new Map();
  for (const segment of segments) {
    if (!segment.content.trim()) continue;
    const key = `${fingerprint(segment.content)}:${canonicalContent(segment.content).length}`;
    if (!exactMap.has(key)) exactMap.set(key, []);
    exactMap.get(key).push(segment.id);
  }
  const exact = [...exactMap.values()].filter((ids) => ids.length > 1).map((segmentIds) => ({ segmentIds, similarityPercent: 100, method: 'canonical whitespace and case equality' }));
  const exactPairs = new Set(exact.flatMap(({ segmentIds }) => segmentIds.flatMap((left, index) => segmentIds.slice(index + 1).map((right) => [left, right].sort().join('\0')))));
  const candidates = segments.filter((segment) => canonicalContent(segment.content).length >= 40);
  const shingleMap = new Map(candidates.map((segment) => [segment.id, shingles(segment.content)]));
  const near = [];
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const left = candidates[leftIndex];
      const right = candidates[rightIndex];
      if (exactPairs.has([left.id, right.id].sort().join('\0'))) continue;
      const value = similarity(shingleMap.get(left.id), shingleMap.get(right.id));
      if (value >= nearDuplicateThreshold) near.push({
        segmentIds: [left.id, right.id],
        similarityPercent: Math.round(value * 1000) / 10,
        method: 'Jaccard similarity over normalised three-word shingles'
      });
    }
  }
  return { exact, near };
}

function secretWarnings(segment) {
  const definitions = [
    { type: 'AWS access key identifier pattern', expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu },
    { type: 'GitHub-style token pattern', expression: /\bgh[opusr]_[A-Za-z0-9]{20,255}\b/gu },
    { type: 'Bearer credential pattern', expression: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/giu },
    { type: 'Private key header', expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu }
  ];
  return definitions.flatMap((definition) => [...segment.content.matchAll(definition.expression)].map((match) => ({
    segmentId: segment.id,
    type: definition.type,
    offset: match.index ?? 0,
    length: match[0].length,
    limitation: 'Local pattern warning only; the matched text is excluded from this finding.'
  })));
}

function truncationWarnings(segment) {
  const marker = /(?:\[\s*(?:\.\.\.)?truncated\s*\]|<truncated>|content omitted|…\s*truncated)/iu.test(segment.content);
  return segment.truncated || marker
    ? [{ segmentId: segment.id, type: 'truncation', evidence: segment.truncated ? 'Segment metadata declares truncation.' : 'Included content contains a recognised truncation marker.' }]
    : [];
}

export function analyseBundle(bundleValue) {
  const bundle = normalisedBundles.has(bundleValue) ? bundleValue : normaliseBundle(bundleValue);
  const measuredSegments = bundle.segments.map((segment, position) => ({
    ...segment,
    position,
    measurement: measureContent(segment.content),
    contentFingerprint: fingerprint(segment.content)
  }));
  const totals = measuredSegments.reduce((result, segment) => ({
    characters: result.characters + segment.measurement.characters,
    bytes: result.bytes + segment.measurement.bytes,
    estimatedTokens: result.estimatedTokens + segment.measurement.estimatedTokens
  }), { characters: 0, bytes: 0, estimatedTokens: 0 });
  const sourceMap = new Map();
  for (const segment of measuredSegments) {
    if (!sourceMap.has(segment.source)) sourceMap.set(segment.source, { source: segment.source, segmentIds: [], characters: 0, bytes: 0, estimatedTokens: 0 });
    const entry = sourceMap.get(segment.source);
    entry.segmentIds.push(segment.id);
    entry.characters += segment.measurement.characters;
    entry.bytes += segment.measurement.bytes;
    entry.estimatedTokens += segment.measurement.estimatedTokens;
  }
  const includedSources = new Set(measuredSegments.map(({ source }) => source));
  const includedIds = new Set(measuredSegments.map(({ id }) => id));
  const unresolvedReferences = bundle.references.filter((reference) => !includedSources.has(reference.path) && !includedIds.has(reference.path)).map((reference) => ({
    ...reference,
    type: 'unresolved reference',
    evidence: 'No included segment has this source path or segment id. The referenced file was not read.'
  }));
  const duplicates = duplicateEvidence(measuredSegments);
  const truncations = measuredSegments.flatMap(truncationWarnings);
  const secrets = measuredSegments.flatMap(secretWarnings);
  const oversizedGenerated = measuredSegments.filter((segment) =>
    segment.measurement.characters >= 20_000
    && /generat|build output|lockfile/iu.test(`${segment.stage} ${segment.transformation} ${segment.source}`)
  ).map((segment) => ({
    segmentId: segment.id,
    type: 'oversized generated content',
    evidence: `${segment.measurement.characters.toLocaleString('en-AU')} characters from a source labelled as generated or transformed output.`
  }));
  const lateSystemInstructions = measuredSegments.filter((segment) => segment.role === 'system' && segment.position > measuredSegments.findIndex(({ role }) => role === 'user') && measuredSegments.some(({ role }) => role === 'user')).map((segment) => ({
    segmentId: segment.id,
    type: 'instruction placement',
    evidence: 'A system-role segment appears after user content in assembly order.'
  }));
  return {
    reportVersion: 1,
    label: bundle.label,
    adapter: bundle.adapter,
    status: 'complete',
    tokeniser: bundle.tokeniser,
    tokenMethod: 'UTF-8 bytes divided by 4, rounded up; deterministic estimate, not an exact provider count',
    totals,
    sources: [...sourceMap.values()].sort((left, right) => right.estimatedTokens - left.estimatedTokens),
    segments: measuredSegments,
    findings: {
      exactDuplicates: duplicates.exact,
      nearDuplicates: duplicates.near,
      truncations,
      unresolvedReferences,
      secretWarnings: secrets,
      oversizedGenerated,
      instructionPlacement: lateSystemInstructions,
      importWarnings: bundle.importWarnings
    },
    privacyBoundary: 'Only included bundle content was analysed. Merely referenced files were not opened or resolved.'
  };
}

export function compareBundles(firstValue, secondValue) {
  const first = analyseBundle(firstValue);
  const second = analyseBundle(secondValue);
  const firstById = new Map(first.segments.map((segment) => [segment.id, segment]));
  const secondById = new Map(second.segments.map((segment) => [segment.id, segment]));
  return {
    firstLabel: first.label,
    secondLabel: second.label,
    estimatedTokenDelta: second.totals.estimatedTokens - first.totals.estimatedTokens,
    added: second.segments.filter(({ id }) => !firstById.has(id)).map(({ id }) => id),
    removed: first.segments.filter(({ id }) => !secondById.has(id)).map(({ id }) => id),
    changed: second.segments.filter((segment) => firstById.has(segment.id) && firstById.get(segment.id).contentFingerprint !== segment.contentFingerprint).map(({ id }) => id),
    reordered: second.segments.filter((segment) => firstById.has(segment.id) && firstById.get(segment.id).position !== segment.position).map(({ id }) => id),
    method: 'Segment identifiers, canonical content fingerprints and assembly positions; no model call or semantic judgement.'
  };
}

function safeReportObject(analysis, includeExcerpts) {
  if (!analysis || analysis.reportVersion !== 1) throw new TypeError('A complete Context X-Ray analysis is required.');
  return {
    reportVersion: 1,
    label: analysis.label,
    adapter: analysis.adapter,
    status: analysis.status,
    tokeniser: analysis.tokeniser,
    tokenMethod: analysis.tokenMethod,
    totals: analysis.totals,
    sources: analysis.sources,
    segments: analysis.segments.map((segment) => ({
      id: segment.id,
      role: segment.role,
      source: segment.source,
      stage: segment.stage,
      position: segment.position,
      contentType: segment.contentType,
      transformation: segment.transformation,
      sensitivity: segment.sensitivity,
      measurement: segment.measurement,
      ...(includeExcerpts ? { excerpt: segment.content.slice(0, 500) } : {})
    })),
    findings: analysis.findings,
    privacyBoundary: analysis.privacyBoundary,
    excerptsIncluded: includeExcerpts
  };
}

export function exportAnalysis(analysis, format = 'json', options = {}) {
  const report = safeReportObject(analysis, options.includeExcerpts === true);
  if (format === 'json') return JSON.stringify(report, null, 2);
  if (format !== 'markdown') throw new RangeError('Unsupported analysis export format.');
  const markdownText = (value) => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/([\\`*_[\]()#+.!|-])/g, '\\$1');
  const lines = [
    `# ${markdownText(report.label)}`,
    '',
    `Status: ${markdownText(report.status)}. Adapter: ${markdownText(report.adapter)}.`,
    '',
    `${report.tokenMethod}.`,
    '',
    markdownText(report.privacyBoundary),
    '',
    `Content excerpts included: ${report.excerptsIncluded ? 'yes, explicitly requested' : 'no'}.`,
    '',
    '## Budget',
    '',
    `- Characters: ${report.totals.characters}`,
    `- UTF-8 bytes: ${report.totals.bytes}`,
    `- Estimated tokens: ${report.totals.estimatedTokens}`,
    ''
  ];
  report.sources.forEach((source) =>
    lines.push(
      `- ${markdownText(source.source)}: ${source.estimatedTokens} estimated tokens across ${source.segmentIds.map(markdownText).join(', ')}`
    )
  );
  lines.push('', '## Findings', '');
  for (const duplicate of report.findings.exactDuplicates) lines.push(`- Exact duplicate: ${duplicate.segmentIds.map(markdownText).join(' and ')}; ${duplicate.similarityPercent}% by ${markdownText(duplicate.method)}.`);
  for (const duplicate of report.findings.nearDuplicates) lines.push(`- Near duplicate: ${duplicate.segmentIds.map(markdownText).join(' and ')}; ${duplicate.similarityPercent}% by ${markdownText(duplicate.method)}.`);
  for (const warning of [...report.findings.truncations, ...report.findings.unresolvedReferences, ...report.findings.secretWarnings, ...report.findings.oversizedGenerated, ...report.findings.instructionPlacement]) {
    lines.push(`- ${markdownText(warning.type)}: ${markdownText(warning.segmentId || warning.path || 'bundle')} — ${markdownText(warning.evidence || warning.limitation)}`);
  }
  if (report.excerptsIncluded) {
    lines.push('', '## Explicitly included excerpts', '');
    report.segments.forEach((segment) => {
      const excerpt = segment.excerpt || '(empty)';
      lines.push(
        `### ${markdownText(segment.id)}`,
        '',
        ...excerpt.split(/\r?\n/).map((line) => `    ${line}`),
        ''
      );
    });
  }
  return lines.join('\n').trim();
}
