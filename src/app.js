import { analyseBundle, compareBundles, exportAnalysis, MAX_SOURCE_CHARACTERS, parseBundle } from './core.js';

const fixture = {
  version: 1,
  label: 'Synthetic coding-agent bundle: repeated lockfile',
  references: [
    { path: 'src/payment/processor.js', fromSegmentId: 'task' },
    { path: 'docs/missing-runbook.md', fromSegmentId: 'task' }
  ],
  segments: [
    {
      id: 'system',
      role: 'system',
      source: 'host:instructions',
      stage: 'instructions',
      content: 'Work only in the supplied fixture. Do not send content to a model or network service.',
      transformation: 'none'
    },
    {
      id: 'task',
      role: 'user',
      source: 'conversation:task',
      stage: 'conversation',
      content: 'Investigate the synthetic payment retry failure. See src/payment/processor.js and docs/missing-runbook.md.',
      references: ['src/payment/processor.js', 'docs/missing-runbook.md']
    },
    {
      id: 'lockfile-a',
      role: 'tool',
      source: 'package-lock.json',
      stage: 'repository retrieval',
      content: 'fixture-lockfile\nalpha@1.0.0 integrity sha512-example\nbeta@2.0.0 integrity sha512-example\ngamma@3.0.0 integrity sha512-example\n',
      transformation: 'full generated file'
    },
    {
      id: 'lockfile-b',
      role: 'tool',
      source: 'retrieval:duplicate-lockfile',
      stage: 'repository retrieval',
      content: 'fixture-lockfile\nalpha@1.0.0 integrity sha512-example\nbeta@2.0.0 integrity sha512-example\ngamma@3.0.0 integrity sha512-example\n',
      transformation: 'duplicated generated file'
    },
    {
      id: 'stale-summary',
      role: 'tool',
      source: 'summary:previous-run',
      stage: 'summary',
      content: 'The synthetic payment processor retries a failed charge three times before returning an error to the caller. The payment processor retries a failed charge three times before returning an error.',
      transformation: 'previous run summary'
    },
    {
      id: 'fresh-summary',
      role: 'tool',
      source: 'summary:current-run',
      stage: 'summary',
      content: 'The synthetic payment processor retries a failed charge three times before returning an error to the caller. The payment processor retries a failed charge three times before returning a recoverable error.',
      transformation: 'current run summary'
    },
    {
      id: 'target-truncated',
      role: 'tool',
      source: 'src/payment/processor.js',
      stage: 'repository retrieval',
      content: 'export async function retryPayment() {\n  const exampleToken = "ghp_1234567890abcdefghijklmnop";\n  // [truncated]\n',
      transformation: 'character-limited excerpt',
      truncated: true,
      sensitivity: 'source code'
    }
  ]
};

const elements = {
  source: document.querySelector('#bundle-source'),
  file: document.querySelector('#bundle-file'),
  includeExcerpts: document.querySelector('#include-excerpts'),
  status: document.querySelector('#job-status'),
  cancel: document.querySelector('#cancel-job'),
  empty: document.querySelector('#empty-state'),
  analysis: document.querySelector('#analysis'),
  title: document.querySelector('#analysis-title'),
  totals: document.querySelector('#totals'),
  estimate: document.querySelector('#estimate-label'),
  bars: document.querySelector('#source-bars'),
  segments: document.querySelector('#segments'),
  findings: document.querySelector('#findings'),
  compare: document.querySelector('#compare-button'),
  dialog: document.querySelector('#work-dialog'),
  dialogStatus: document.querySelector('#dialog-job-status'),
  dialogCancel: document.querySelector('#dialog-cancel-job'),
  dialogContent: document.querySelector('#dialog-content')
};

let currentBundle = null;
let currentAnalysis = null;
let activeController = null;
let sourceRevision = 0;

function setStatus(message, loading = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle('loading', loading);
  elements.cancel.hidden = !loading;
  elements.dialogStatus.textContent = message;
  elements.dialogStatus.classList.toggle('loading', loading);
  elements.dialogStatus.hidden = !elements.dialog.open && !loading;
  elements.dialogCancel.hidden = !loading;
}

function discardAnalysis(message) {
  sourceRevision += 1;
  activeController?.abort();
  currentBundle = null;
  currentAnalysis = null;
  elements.analysis.hidden = true;
  elements.empty.hidden = false;
  elements.compare.disabled = true;
  elements.title.textContent = 'No current analysis';
  elements.totals.replaceChildren();
  elements.bars.replaceChildren();
  elements.segments.replaceChildren();
  elements.findings.replaceChildren();
  if (elements.dialog.open) elements.dialog.close();
  setStatus(message);
}

function delay(signal, stage) {
  setStatus(`Loading: ${stage}`, true);
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, 55);
    signal.addEventListener('abort', () => {
      window.clearTimeout(timer);
      reject(new DOMException('Cancelled', 'AbortError'));
    }, { once: true });
  });
}

async function analyse() {
  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;
  const revision = sourceRevision;
  try {
    await delay(controller.signal, 'normalising included segments');
    const bundle = parseBundle(elements.source.value);
    await delay(controller.signal, `measuring ${bundle.segments.length} segments`);
    await delay(controller.signal, 'indexing exact and near duplicates');
    await delay(controller.signal, 'checking truncation, references and secret patterns');
    const result = analyseBundle(bundle);
    if (controller.signal.aborted || revision !== sourceRevision) {
      throw new DOMException('Cancelled', 'AbortError');
    }
    currentBundle = bundle;
    currentAnalysis = result;
    renderAnalysis(result);
    setStatus(`Analysis complete: ${result.segments.length} segments and ${result.totals.estimatedTokens.toLocaleString('en-AU')} labelled estimated tokens.`);
  } catch (error) {
    if (activeController !== controller) return;
    setStatus(error.name === 'AbortError'
      ? revision !== sourceRevision
        ? 'Bundle source changed. The previous analysis was discarded; analyse the current source.'
        : 'Analysis cancelled. Partial work was discarded and the prior complete report remains unchanged.'
      : `Analysis failed: ${error.message}`);
  } finally {
    if (activeController === controller) activeController = null;
  }
}

function addTotal(label, value) {
  const group = document.createElement('div');
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = value.toLocaleString('en-AU');
  group.append(term, description);
  elements.totals.append(group);
}

function renderAnalysis(analysis) {
  elements.empty.hidden = true;
  elements.analysis.hidden = false;
  elements.compare.disabled = false;
  elements.title.textContent = analysis.label;
  elements.totals.replaceChildren();
  addTotal('Characters', analysis.totals.characters);
  addTotal('UTF-8 bytes', analysis.totals.bytes);
  addTotal('Estimated tokens', analysis.totals.estimatedTokens);
  elements.estimate.textContent = `${analysis.tokenMethod}. Adapter: ${analysis.adapter}.`;

  elements.bars.replaceChildren();
  const maximum = Math.max(1, ...analysis.sources.map(({ estimatedTokens }) => estimatedTokens));
  for (const source of analysis.sources) {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = source.source;
    const track = document.createElement('span');
    track.className = 'bar-track';
    const fill = document.createElement('span');
    fill.style.width = `${Math.max(1, (source.estimatedTokens / maximum) * 100)}%`;
    track.append(fill);
    const amount = document.createElement('span');
    amount.textContent = `${source.estimatedTokens.toLocaleString('en-AU')} est. tokens`;
    item.append(name, track, amount);
    elements.bars.append(item);
  }

  elements.segments.replaceChildren();
  for (const segment of analysis.segments) {
    const item = document.createElement('li');
    item.id = `segment-${segment.id}`;
    const position = document.createElement('span');
    position.className = 'position';
    position.textContent = String(segment.position + 1).padStart(2, '0');
    const meta = document.createElement('div');
    meta.className = 'segment-meta';
    const name = document.createElement('strong');
    name.textContent = `${segment.id} · ${segment.source}`;
    const details = document.createElement('p');
    details.textContent = `${segment.role} · ${segment.stage} · ${segment.measurement.characters.toLocaleString('en-AU')} characters · ${segment.measurement.estimatedTokens.toLocaleString('en-AU')} estimated tokens`;
    meta.append(name, details);
    const inspect = document.createElement('button');
    inspect.type = 'button';
    inspect.textContent = 'Inspect included text';
    inspect.addEventListener('click', () => showSegment(segment));
    item.append(position, meta, inspect);
    elements.segments.append(item);
  }
  renderFindings(analysis);
}

function focusSegments(ids) {
  for (const item of elements.segments.children) item.classList.remove('highlight');
  const first = ids.map((id) => document.querySelector(`#segment-${CSS.escape(id)}`)).find(Boolean);
  for (const id of ids) document.querySelector(`#segment-${CSS.escape(id)}`)?.classList.add('highlight');
  first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  first?.focus({ preventScroll: true });
}

function findingGroup(title, values, describe) {
  const section = document.createElement('section');
  section.className = 'finding-group';
  const heading = document.createElement('h4');
  heading.textContent = `${title} (${values.length})`;
  const list = document.createElement('ol');
  if (!values.length) {
    const item = document.createElement('li');
    item.textContent = 'None detected by this rule.';
    list.append(item);
  }
  values.forEach((value) => {
    const item = document.createElement('li');
    const description = describe(value);
    if (description.ids) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = description.text;
      button.addEventListener('click', () => focusSegments(description.ids));
      item.append(button);
    } else {
      item.textContent = description.text;
      if (description.warning) item.className = 'warning';
    }
    list.append(item);
  });
  section.append(heading, list);
  elements.findings.append(section);
}

function renderFindings(analysis) {
  elements.findings.replaceChildren();
  findingGroup('Exact duplicates', analysis.findings.exactDuplicates, (value) => ({ ids: value.segmentIds, text: `${value.segmentIds.join(' ↔ ')}: ${value.similarityPercent}% by ${value.method}.` }));
  findingGroup('Near duplicates', analysis.findings.nearDuplicates, (value) => ({ ids: value.segmentIds, text: `${value.segmentIds.join(' ↔ ')}: ${value.similarityPercent}% by ${value.method}.` }));
  findingGroup('Truncation', analysis.findings.truncations, (value) => ({ ids: [value.segmentId], text: `${value.segmentId}: ${value.evidence}` }));
  findingGroup('Unresolved references', analysis.findings.unresolvedReferences, (value) => ({ text: `${value.path}: ${value.evidence}`, warning: true }));
  findingGroup('Likely secrets', analysis.findings.secretWarnings, (value) => ({ ids: [value.segmentId], text: `${value.segmentId}: ${value.type} at character ${value.offset + 1}. ${value.limitation}` }));
  findingGroup('Other structural warnings', [...analysis.findings.oversizedGenerated, ...analysis.findings.instructionPlacement], (value) => ({ ids: [value.segmentId], text: `${value.segmentId}: ${value.evidence}` }));
}

function showSegment(segment) {
  elements.dialogContent.replaceChildren();
  const heading = document.createElement('h2');
  heading.textContent = `${segment.id} · ${segment.source}`;
  const boundary = document.createElement('p');
  boundary.textContent = `Included segment at assembly position ${segment.position + 1}. ${segment.measurement.tokenMethod}. Imported text is rendered inertly.`;
  const preview = document.createElement('pre');
  preview.className = 'content-preview';
  preview.textContent = segment.content || '(No included text content.)';
  elements.dialogContent.append(heading, boundary, preview);
  elements.dialog.showModal();
}

function download(content, extension, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `context-xray-report.${extension}`;
  link.click();
  URL.revokeObjectURL(url);
}

function openExport() {
  if (!currentAnalysis) {
    setStatus('No current analysis is available to export. Analyse the current bundle first.');
    return;
  }
  elements.dialogContent.replaceChildren();
  const heading = document.createElement('h2');
  heading.textContent = 'Content-safe export';
  const review = document.createElement('p');
  review.textContent = elements.includeExcerpts.checked
    ? 'You explicitly selected excerpts. Each exported excerpt is limited to 500 characters, but it may still contain sensitive content.'
    : 'Default export contains measurements, source labels, segment identifiers and findings. It excludes included content excerpts and matched secret text.';
  const actions = document.createElement('div');
  actions.className = 'export-actions';
  for (const [label, format, extension, type] of [
    ['Download JSON', 'json', 'json', 'application/json;charset=utf-8'],
    ['Download Markdown', 'markdown', 'md', 'text/markdown;charset=utf-8']
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', async () => {
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      const revision = sourceRevision;
      const analysis = currentAnalysis;
      try {
        await delay(controller.signal, `preparing ${format} export`);
        if (
          revision !== sourceRevision ||
          analysis === null ||
          analysis !== currentAnalysis
        ) {
          throw new DOMException('Cancelled', 'AbortError');
        }
        const output = exportAnalysis(analysis, format, { includeExcerpts: elements.includeExcerpts.checked });
        download(output, extension, type);
        setStatus(`${format} export prepared locally.`);
      } catch (error) {
        if (activeController !== controller) return;
        setStatus(error.name === 'AbortError' ? 'Export cancelled.' : `Export failed: ${error.message}`);
      } finally {
        if (activeController === controller) activeController = null;
      }
    });
    actions.append(button);
  }
  elements.dialogContent.append(heading, review, actions);
  elements.dialog.showModal();
}

function openComparison() {
  if (!currentBundle) {
    setStatus('No current analysis is available to compare. Analyse the current bundle first.');
    return;
  }
  elements.dialogContent.replaceChildren();
  const heading = document.createElement('h2');
  heading.textContent = 'Compare with another supplied bundle';
  const explanation = document.createElement('p');
  explanation.textContent = 'Comparison uses segment identifiers, canonical fingerprints and the relative order of shared segments. It does not judge relevance or call a model.';
  const label = document.createElement('label');
  label.htmlFor = 'comparison-source';
  label.textContent = 'Second bundle JSON';
  const textarea = document.createElement('textarea');
  textarea.id = 'comparison-source';
  textarea.rows = 14;
  textarea.value = JSON.stringify({ ...fixture, label: 'Synthetic bundle without repeated lockfile', segments: fixture.segments.filter(({ id }) => id !== 'lockfile-b') }, null, 2);
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Compare included bundles';
  const output = document.createElement('div');
  output.className = 'comparison-output';
  const sourceBundle = currentBundle;
  const revision = sourceRevision;
  button.addEventListener('click', async () => {
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    try {
      await delay(controller.signal, 'normalising and comparing both bundles');
      if (
        revision !== sourceRevision ||
        sourceBundle === null ||
        sourceBundle !== currentBundle
      ) {
        throw new DOMException('Cancelled', 'AbortError');
      }
      const comparison = compareBundles(sourceBundle, parseBundle(textarea.value));
      output.replaceChildren();
      const summary = document.createElement('p');
      summary.textContent = `Estimated token delta: ${comparison.estimatedTokenDelta >= 0 ? '+' : ''}${comparison.estimatedTokenDelta}. Added: ${comparison.added.join(', ') || 'none'}. Removed: ${comparison.removed.join(', ') || 'none'}. Changed: ${comparison.changed.join(', ') || 'none'}. Reordered: ${comparison.reordered.join(', ') || 'none'}.`;
      const method = document.createElement('p');
      method.textContent = comparison.method;
      output.append(summary, method);
      setStatus('Bundle comparison complete.');
    } catch (error) {
      if (activeController !== controller) return;
      setStatus(error.name === 'AbortError' ? 'Comparison cancelled.' : `Comparison failed: ${error.message}`);
    } finally {
      if (activeController === controller) activeController = null;
    }
  });
  elements.dialogContent.append(heading, explanation, label, textarea, button, output);
  elements.dialog.showModal();
}

document.querySelector('#fixture-button').addEventListener('click', () => {
  discardAnalysis('Synthetic bundle selected. Analyse it to create a current report.');
  elements.source.value = JSON.stringify(fixture, null, 2);
  elements.source.focus();
  setStatus('Synthetic repeated-lockfile bundle loaded. Analyse included content when ready.');
});
document.querySelector('#analyse-button').addEventListener('click', analyse);
elements.source.addEventListener('input', () => {
  discardAnalysis('Bundle source changed. The previous analysis and export were discarded.');
});
elements.file.addEventListener('change', async () => {
  const file = elements.file.files?.[0];
  if (!file) return;
  discardAnalysis('A different local bundle was selected. Reading it now.');
  const controller = new AbortController();
  activeController = controller;
  setStatus('Loading: reading the explicitly selected bundle', true);
  try {
    // UTF-8 needs at most four bytes per character, so a larger file cannot fit the limit.
    if (file.size > MAX_SOURCE_CHARACTERS * 4) {
      throw new RangeError(`Bundle files are limited to ${MAX_SOURCE_CHARACTERS.toLocaleString('en-AU')} characters.`);
    }
    const source = await file.text();
    if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    elements.source.value = source;
    setStatus('Local bundle loaded as untrusted text. Analyse it to create measurements.');
  } catch (error) {
    if (activeController !== controller) return;
    setStatus(error.name === 'AbortError' ? 'Bundle reading cancelled.' : `Bundle reading failed: ${error.message}`);
  } finally {
    if (activeController === controller) activeController = null;
  }
});
elements.cancel.addEventListener('click', () => activeController?.abort());
elements.dialogCancel.addEventListener('click', () => activeController?.abort());
elements.compare.addEventListener('click', openComparison);
document.querySelector('#export-button').addEventListener('click', openExport);
document.querySelector('#privacy-button').addEventListener('click', () => {
  elements.dialogContent.replaceChildren();
  const heading = document.createElement('h2');
  heading.textContent = 'Analysis boundary';
  const text = document.createElement('p');
  text.textContent = 'Context X-Ray analyses only strings included in the JSON you explicitly supply. It makes no model or network request, does not resolve file paths, and does not inspect chain-of-thought. Token counts are a labelled deterministic estimate unless a future exact tokeniser is explicitly named.';
  elements.dialogContent.append(heading, text);
  elements.dialog.showModal();
});
