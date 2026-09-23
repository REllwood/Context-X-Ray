#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { analyseBundle, exportAnalysis, MAX_SOURCE_CHARACTERS, parseBundle } from './core.js';

const sourceLimitMessage = `Bundle input exceeds ${MAX_SOURCE_CHARACTERS.toLocaleString('en-AU')} characters.`;

async function standardInput() {
  let source = '';
  for await (const chunk of process.stdin) {
    source += chunk;
    if (source.length > MAX_SOURCE_CHARACTERS) throw new RangeError(sourceLimitMessage);
  }
  return source;
}

async function fileInput(path) {
  // UTF-8 needs at most three bytes per UTF-16 code unit, so a larger file cannot fit the limit.
  if ((await stat(path)).size > MAX_SOURCE_CHARACTERS * 3) throw new RangeError(sourceLimitMessage);
  return readFile(path, 'utf8');
}

try {
  process.stderr.write('Loading: measuring the explicitly supplied context bundle locally. No model or referenced file is contacted.\n');
  const path = process.argv[2];
  const source = path ? await fileInput(path) : await standardInput();
  const analysis = analyseBundle(parseBundle(source));
  process.stdout.write(`${exportAnalysis(analysis, 'json', { includeExcerpts: process.argv.includes('--include-excerpts') })}\n`);
  process.stderr.write(`Analysis complete: ${analysis.segments.length} segments and ${analysis.totals.estimatedTokens} labelled estimated tokens.\n`);
} catch (error) {
  process.stderr.write(`Context X-Ray failed: ${error.message}\n`);
  process.exitCode = 1;
}
