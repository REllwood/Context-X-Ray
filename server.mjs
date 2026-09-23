import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const host = '127.0.0.1';
const portIndex = process.argv.indexOf('--port');
const requested = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : Number(process.env.PORT ?? 4182);
const port = Number.isInteger(requested) && requested >= 0 && requested <= 65535 ? requested : 4182;
const types = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8']
]);
const publicFiles = new Map([
  ['/', join(root, 'index.html')],
  ['/index.html', join(root, 'index.html')],
  ['/src/app.js', join(root, 'src', 'app.js')],
  ['/src/core.js', join(root, 'src', 'core.js')],
  ['/src/session.js', join(root, 'src', 'session.js')],
  ['/src/styles.css', join(root, 'src', 'styles.css')]
]);

const baseHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

function sendText(response, status, text, headers = {}) {
  response.writeHead(status, { ...baseHeaders, 'Content-Type': 'text/plain; charset=utf-8', ...headers }).end(text);
}

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendText(response, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    return;
  }
  let target;
  try {
    target = publicFiles.get(decodeURIComponent(new URL(request.url ?? '/', `http://${host}`).pathname));
  } catch {
    sendText(response, 400, 'Invalid request');
    return;
  }
  if (!target) {
    sendText(response, 404, 'Not found');
    return;
  }
  // Read before writing headers, so a failed read can still send an error status.
  let body;
  try {
    body = await readFile(target);
  } catch (error) {
    const missing = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
    sendText(response, missing ? 404 : 500, missing ? 'Not found' : 'File could not be read');
    return;
  }
  response.writeHead(200, {
    ...baseHeaders,
    'Content-Type': types.get(extname(target)) ?? 'application/octet-stream',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
  });
  response.end(body);
});

server.on('error', (error) => {
  console.error(`Context X-Ray could not start on http://${host}:${port}: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  const address = server.address();
  const activePort = address && typeof address === 'object' ? address.port : port;
  console.log(`Context X-Ray is available at http://${host}:${activePort}`);
});
const close = () => server.close(() => process.exit(0));
process.on('SIGINT', close);
process.on('SIGTERM', close);
