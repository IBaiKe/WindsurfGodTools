/**
 * [INPUT]: node:https, node:http for HTTP requests; config.js for env-driven defaults
 * [OUTPUT]: ConcurrencySemaphore, globalSemaphore, lsSemaphore, fetchWithRetry, fetchStream, httpsRequest
 * [POS]: 并发控制与速率限制基础设施，被 providers/*.js、router.js 和 handlers/chat.js 消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { config, log } from './config.js';
import https from 'node:https';
import http from 'node:http';

// ═══════════════════════════════════════════════════════════════════════
//  Concurrency Semaphore — FIFO slot queue
// ═══════════════════════════════════════════════════════════════════════

export class ConcurrencySemaphore {
  constructor(max = config.maxConcurrent) {
    this._max = max;
    this._active = 0;
    this._queue = [];
  }

  get active()  { return this._active; }
  get pending() { return this._queue.length; }

  acquire() {
    if (this._active < this._max) {
      this._active++;
      return Promise.resolve();
    }
    return new Promise(resolve => this._queue.push(resolve));
  }

  release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    } else {
      this._active = Math.max(0, this._active - 1);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Global semaphore — shared across all direct-provider requests
// ═══════════════════════════════════════════════════════════════════════

const globalSemaphore = new ConcurrencySemaphore();
export { globalSemaphore };

// ═══════════════════════════════════════════════════════════════════════
//  LS semaphore — caps concurrent gRPC requests to Language Server
// ═══════════════════════════════════════════════════════════════════════

const lsSemaphore = new ConcurrencySemaphore(config.maxLsConcurrent);
export { lsSemaphore };

// ═══════════════════════════════════════════════════════════════════════
//  Zero-dependency HTTPS request
// ═══════════════════════════════════════════════════════════════════════

export function httpsRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'POST',
      headers: options.headers || {},
      ...options.agent && { agent: options.agent },
    };

    const req = mod.request(reqOpts, (res) => {
      if (options.stream) {
        resolve({ status: res.statusCode, headers: res.headers, body: res });
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    });

    req.on('error', reject);
    if (options.signal) {
      options.signal.addEventListener('abort', () => req.destroy(new Error('aborted')));
    }
    if (body) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      req.end(payload);
    } else {
      req.end();
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════
//  fetchWithRetry — 429 retry + proactive throttle
// ═══════════════════════════════════════════════════════════════════════

const DEFAULT_RETRY_DELAY_S = 5;
const REMAINING_THRESHOLD   = config.rateLimitThreshold;
const MAX_RETRIES           = config.maxRetries;

function parseRetryAfter(headers) {
  const val = headers['retry-after'];
  if (!val) return DEFAULT_RETRY_DELAY_S;
  const n = Number(val);
  return Number.isFinite(n) ? Math.max(n, 1) : DEFAULT_RETRY_DELAY_S;
}

function parseRemaining(headers) {
  const val = headers['x-ratelimit-remaining-requests'] ??
              headers['x-ratelimit-remaining-tokens'];
  if (!val) return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {() => Promise<{status:number, headers:object, body:any}>} requestFn
 * @param {object} opts
 * @param {number}  [opts.maxRetries]
 * @param {ConcurrencySemaphore} [opts.semaphore]
 * @param {string}  [opts.reqId]
 * @param {AbortSignal} [opts.signal]
 */
export async function fetchWithRetry(requestFn, opts = {}) {
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const sem = opts.semaphore ?? globalSemaphore;
  const id = opts.reqId ?? '';

  await sem.acquire();
  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (opts.signal?.aborted) throw new Error('aborted');

      const result = await requestFn();

      // -- proactive throttle --
      const remaining = parseRemaining(result.headers);
      if (remaining !== null && remaining <= REMAINING_THRESHOLD) {
        const pause = parseRetryAfter(result.headers);
        log.warn(`[rate-limit] ${id} remaining=${remaining}, pausing ${pause}s`);
        await sleep(pause * 1000);
      }

      // -- 429 auto-retry --
      if (result.status === 429) {
        if (attempt >= maxRetries) {
          log.warn(`[rate-limit] ${id} 429 after ${maxRetries} retries, giving up`);
          return result;
        }
        const delay = parseRetryAfter(result.headers);
        log.warn(`[rate-limit] ${id} 429, retry ${attempt + 1}/${maxRetries} after ${delay}s`);
        await sleep(delay * 1000);
        continue;
      }

      return result;
    }
  } finally {
    sem.release();
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Streaming fetch — returns raw response stream for SSE piping
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param {string} url
 * @param {object} options
 * @param {*} body
 * @param {ConcurrencySemaphore} [semaphore]
 * @returns {Promise<{status, headers, body: IncomingMessage, release: () => void}>}
 */
export async function fetchStream(url, options, body, semaphore) {
  const sem = semaphore ?? globalSemaphore;
  await sem.acquire();
  let released = false;
  const release = () => { if (!released) { released = true; sem.release(); } };

  try {
    const result = await httpsRequest(url, { ...options, stream: true }, body);
    result.release = release;
    result.body.on('end', release);
    result.body.on('error', release);
    return result;
  } catch (e) {
    release();
    throw e;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
