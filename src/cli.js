#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { analyseBundle, exportAnalysis, MAX_SOURCE_CHARACTERS, parseBundle } from './core.js';

const usage = `Usage: node src/cli.js [--include-excerpts] [bundle.json]

Measures a context bundle and prints a JSON report. Reads standard input when no file is given.

  --include-excerpts  include the first 500 characters of each segment in the report
  -h, --help          show this message
`;
const sourceLimitMessage = `Bundle input exceeds ${MAX_SOURCE_CHARACTERS.toLocaleString('en-AU')} characters.`;

async function standardInput() {
  // Decoding as a stream keeps multi-byte characters that are split across chunks intact.
  process.stdin.setEncoding('utf8');
  let source = '';
  for await (const chunk of process.stdin) {
    source += chunk;
    // A character is at most two UTF-16 code units; parseBundle applies the exact limit.
    if (source.length > MAX_SOURCE_CHARACTERS * 2) throw new RangeError(sourceLimitMessage);
  }
  return source;
}

async function fileInput(path) {
  // UTF-8 needs at most four bytes per character, so a larger file cannot fit the limit.
  if ((await stat(path)).size > MAX_SOURCE_CHARACTERS * 4) throw new RangeError(sourceLimitMessage);
  return readFile(path, 'utf8');
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'include-excerpts': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false }
    }
  });
  if (values.help) {
    process.stdout.write(usage);
  } else if (positionals.length > 1) {
    throw new RangeError('Supply at most one bundle file.');
  } else if (!positionals.length && process.stdin.isTTY) {
    process.stderr.write(usage);
    process.exitCode = 1;
  } else {
    process.stderr.write('Loading: measuring the explicitly supplied context bundle locally. No model or referenced file is contacted.\n');
    const [path] = positionals;
    const source = path ? await fileInput(path) : await standardInput();
    const analysis = analyseBundle(parseBundle(source));
    process.stdout.write(`${exportAnalysis(analysis, 'json', { includeExcerpts: values['include-excerpts'] })}\n`);
    process.stderr.write(`Analysis complete: ${analysis.segments.length} segments and ${analysis.totals.estimatedTokens} labelled estimated tokens.\n`);
  }
} catch (error) {
  process.stderr.write(`Context X-Ray failed: ${error.message}\n`);
  process.exitCode = 1;
}
