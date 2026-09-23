<div align="center">

# Context X-Ray

**See exactly what occupies an agent's context window before asking the model to use it.**

[![License: MIT](https://img.shields.io/badge/license-MIT-2f6f4e?style=flat-square)](LICENSE)
![Node 22+](https://img.shields.io/badge/node-%3E%3D22-43853d?style=flat-square&logo=node.js&logoColor=white)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-555?style=flat-square)

</div>

When a coding agent gives a bad answer, the cause is often what went into its context: the same file twice, a stale summary, a huge lockfile, a source file cut off halfway. Context X-Ray breaks a context bundle down by source, so you can see where the budget went before you blame the model.

## What it does

- Imports a provider-neutral context bundle, or an Anthropic- or OpenAI-style message export, including tool calls and tool results
- Measures characters, bytes and estimated tokens for every source
- Finds exact and near duplicates, and links them to the segments involved
- Flags truncation, unresolved references, oversized generated files and likely secrets
- Compares two bundles for the same task
- Exports measurements with excerpts left out by default
- Makes no model calls, and never opens files that are only referenced
- Handles bundles of up to 1,000 segments and 4,000,000 characters of included content (about a million estimated tokens)

## Quick start

Requires Node.js 22 or newer. No `npm install` needed.

```sh
git clone https://github.com/REllwood/Context-X-Ray.git
cd Context-X-Ray
npm start
```

Open http://127.0.0.1:4182 to use the viewer.

Or run a report from the command line:

```sh
node src/cli.js fixtures/repeated-context.json
```

## Status

v0.1 works on exported bundles. Next up are live instrumentation for agent hosts, and context checks you can run in CI.

## Development

```sh
npm test        # analysis tests
npm run check   # tests plus syntax checks
```

## License

[MIT](LICENSE)
