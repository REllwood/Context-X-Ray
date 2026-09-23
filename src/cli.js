#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { analyseBundle, exportAnalysis, parseBundle } from './core.js';

async function standardInput() {
  let source = '';
  for await (const chunk of process.stdin) {
    source += chunk;
    if (source.length > 1_250_000) throw new RangeError('Bundle input exceeds 1,250,000 characters.');
  }
  return source;
}

try {
  process.stderr.write('Loading: measuring the explicitly supplied context bundle locally. No model or referenced file is contacted.\n');
  const path = process.argv[2];
  const source = path ? await readFile(path, 'utf8') : await standardInput();
  const analysis = analyseBundle(parseBundle(source));
  process.stdout.write(`${exportAnalysis(analysis, 'json', { includeExcerpts: process.argv.includes('--include-excerpts') })}\n`);
  process.stderr.write(`Analysis complete: ${analysis.segments.length} segments and ${analysis.totals.estimatedTokens} labelled estimated tokens.\n`);
} catch (error) {
  process.stderr.write(`Context X-Ray failed: ${error.message}\n`);
  process.exitCode = 1;
}
