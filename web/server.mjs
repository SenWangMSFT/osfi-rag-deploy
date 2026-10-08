// Production server for the App Service web app. Serves the built React app from dist/ and proxies /api/* to
// the Function App, adding the function key here so it never reaches the browser, and the signed-in user's Azure AI
// Search token so the API searches as that user. Node built-ins only, so the deployment package needs no node_modules.
//
//   API_BASE_URL      Function App URL (default http://localhost:7071, the local Functions host)
//   API_KEY           Function key (not needed for the local Functions host)
//   PORT              Set by App Service (default 8080)
//   LOCAL_USER_TOKEN  'az' (local runs only): use your az login identity's token instead of App Service sign-in

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync, constants as zlib } from 'node:zlib';

const port = Number(process.env.PORT ?? 8080);
const apiBaseUrl = (process.env.API_BASE_URL || 'http://localhost:7071').replace(/\/+$/, '');
const apiKey = process.env.API_KEY ?? '';
const localUserToken = process.env.LOCAL_USER_TOKEN === 'az';
const distDir = fileURLToPath(new URL('./dist/', import.meta.url));

// The API reads the user's token from this header (src/function_app/rag/auth.py).
const USER_TOKEN_HEADER = 'x-search-user-token';
// App Service authentication injects the signed-in user's access token, for the scope its sign-in requested
// (Azure AI Search, infra/modules/webapp.bicep), and refreshes it through /.auth/refresh.
const SIGN_IN_TOKEN_HEADER = 'x-ms-token-aad-access-token';

// The knowledge base can take 20-30 s on a hard question; App Service's front end allows 230 s.
const API_TIMEOUT_MS = 120_000;
// Matches the browser transport budget and Function API; long chats are token-budgeted by the API.
const MAX_BODY_BYTES = 16 * 1024 * 1024;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt']);

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    // The source viewer embeds PDFs that /api/docs streams from SharePoint.
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

// Hop-by-hop headers, plus encoding/length (fetch already decoded the body) and cookies from the Function App.
const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
  'set-cookie',
]);

function loadAssets(dir) {
  const assets = new Map();
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const body = readFileSync(path);
      const ext = extname(entry.name).toLowerCase();
      const urlPath = `/${relative(dir, path).split(sep).join('/')}`;
      const compress = COMPRESSIBLE.has(ext) && body.length > 1024;
      assets.set(urlPath, {
        body,
        type: CONTENT_TYPES[ext] ?? 'application/octet-stream',
        etag: `"${createHash('sha1').update(body).digest('base64url')}"`,
        // Vite fingerprints everything under /assets, so those files never change.
        immutable: urlPath.startsWith('/assets/'),
        br: compress ? brotliCompressSync(body, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11 } }) : null,
        gzip: compress ? gzipSync(body, { level: 9 }) : null,
      });
    }
  };
  walk(dir);
  return assets;
}

const assets = loadAssets(distDir);

let cliToken = null;

/** Local runs: your az login identity's Azure AI Search token, refreshed a few minutes before it expires. */
function azCliToken() {
  if (!cliToken || cliToken.expires - Date.now() < 5 * 60_000) {
    const output = execSync(
      'az account get-access-token --resource https://search.azure.com --query "{token:accessToken,expires:expires_on}" -o json',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const { token, expires } = JSON.parse(output);
    cliToken = { token, expires: Number(expires) * 1000 };
  }
  return cliToken.token;
}

function userToken(req) {
  if (localUserToken) return azCliToken();
  const token = req.headers[SIGN_IN_TOKEN_HEADER];
  return typeof token === 'string' && token ? token : undefined;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let asset = assets.get(pathname);
  if (!asset) {
    // Paths without a file extension are client-side routes; anything else is a real 404.
    if (extname(pathname)) return sendJson(res, 404, { error: 'Not found.' });
    asset = assets.get('/index.html');
  }
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': asset.type,
    'Cache-Control': asset.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    ETag: asset.etag,
    Vary: 'Accept-Encoding',
  };
  if (req.headers['if-none-match'] === asset.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const accepted = req.headers['accept-encoding'] ?? '';
  let body = asset.body;
  if (asset.br && /\bbr\b/.test(accepted)) {
    body = asset.br;
    headers['Content-Encoding'] = 'br';
  } else if (asset.gzip && /\bgzip\b/.test(accepted)) {
    body = asset.gzip;
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => resolve(size > MAX_BODY_BYTES ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function proxy(req, res, url) {
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const body = hasBody ? await readBody(req) : undefined;
  if (body === null) return sendJson(res, 413, { error: 'Request body is too large.' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), API_TIMEOUT_MS);
  // Stop the upstream call if the browser gives up (e.g. the user presses Stop).
  res.on('close', () => controller.abort(new Error('client closed')));
  try {
    const token = userToken(req);
    const upstream = await fetch(`${apiBaseUrl}${url.pathname}${url.search}`, {
      method: req.method,
      // Only these headers are forwarded; the caller can't supply its own key or user token.
      headers: {
        accept: req.headers.accept ?? 'application/json',
        ...(hasBody ? { 'content-type': req.headers['content-type'] ?? 'application/json' } : {}),
        ...(apiKey ? { 'x-functions-key': apiKey } : {}),
        ...(token ? { [USER_TOKEN_HEADER]: token } : {}),
      },
      body,
      // Keep any redirect for the browser to handle rather than following it here.
      redirect: 'manual',
      signal: controller.signal,
    });
    const headers = {};
    upstream.headers.forEach((value, name) => {
      if (!DROPPED_RESPONSE_HEADERS.has(name)) headers[name] = value;
    });
    headers['cache-control'] ??= 'no-store';
    res.writeHead(upstream.status, headers);
    if (upstream.body && req.method !== 'HEAD') await pipeline(Readable.fromWeb(upstream.body), res);
    else res.end();
  } catch (error) {
    if (res.headersSent) return res.destroy();
    const timedOut = controller.signal.reason?.message === 'timeout';
    if (!timedOut && res.destroyed) return;
    console.error(`proxy ${req.method} ${url.pathname} failed:`, error?.cause ?? error);
    sendJson(res, timedOut ? 504 : 502, {
      error: timedOut ? 'The API took too long to respond.' : 'Could not reach the API.',
    });
  } finally {
    clearTimeout(timer);
  }
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return sendJson(res, 400, { error: 'Bad request.' });
  }
  try {
    if (url.pathname === '/healthz') return sendJson(res, 200, { status: 'ok' });
    if (url.pathname.startsWith('/api/')) {
      await proxy(req, res, url);
      console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed.' });
    serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal error.' });
  }
});

// Longer than the Azure front end's idle timeout, so it never reuses a connection Node has already closed.
server.keepAliveTimeout = 250_000;
server.headersTimeout = 255_000;

server.listen(port, () => {
  const extras = [apiKey && 'function key', localUserToken && 'your az login token'].filter(Boolean).join(' and ');
  console.log(`Listening on http://localhost:${port} (${assets.size} files); /api -> ${apiBaseUrl}${extras ? ` with ${extras}` : ''}`);
});
