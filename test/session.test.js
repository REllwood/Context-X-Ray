import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalysisSession } from '../src/session.js';

const bundle = { label: 'bundle' };
const analysis = { label: 'analysis' };

test('a finished analysis is published only if the source did not change while it ran', () => {
  const session = createAnalysisSession();
  assert.equal(session.analysis, null);

  const completed = session.begin();
  assert.equal(session.commit(completed, bundle, analysis), true);
  assert.equal(session.bundle, bundle);
  assert.equal(session.analysis, analysis);

  const interrupted = session.begin();
  session.discard();
  assert.equal(session.commit(interrupted, { label: 'stale' }, { label: 'stale' }), false);
  assert.equal(session.analysis, null);
});

test('editing the source discards the analysis used for comparison and export', () => {
  const session = createAnalysisSession();
  session.commit(session.begin(), bundle, analysis);
  const exportTicket = session.begin();
  assert.equal(exportTicket.analysis, analysis);
  assert.equal(session.isCurrent(exportTicket), true);

  session.discard();
  assert.equal(session.bundle, null);
  assert.equal(session.analysis, null);
  assert.equal(session.isCurrent(exportTicket), false);
});

test('work based on an analysis is stale once a newer analysis replaces it', () => {
  const session = createAnalysisSession();
  session.commit(session.begin(), bundle, analysis);
  const comparisonTicket = session.begin();
  session.commit(session.begin(), { label: 'newer bundle' }, { label: 'newer analysis' });
  assert.equal(session.isCurrent(comparisonTicket), false);
  assert.equal(comparisonTicket.bundle, bundle);
});
