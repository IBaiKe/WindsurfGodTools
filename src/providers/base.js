/**
 * [INPUT]: rate-limit.js 的 httpsRequest/fetchWithRetry/fetchStream, config.js
 * [OUTPUT]: BaseProvider 基类，parseSSE 工具函数
 * [POS]: providers/ 的基础设施，被 anthropic.js/openai.js/gemini.js 继承
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { httpsRequest, fetchWithRetry, fetchStream, globalSemaphore } from '../rate-limit.js';
import { log } from '../config.js';

// ═══════════════════════════════════════════════════════════════════════
//  SSE line parser — shared across all streaming providers
// ═══════════════════════════════════════════════════════════════════════

export function parseSSELines(chunk, buffer) {
  const text = buffer + chunk;
  const events = [];
  let rest = '';
  const parts = text.split('\n');

  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (i === parts.length - 1 && !text.endsWith('\n')) {
      rest = line;
      break;
    }
    if (line.startsWith('data: ')) {
      const data = line.slice(6);
      if (data === '[DONE]') {
        events.push({ done: true });
      } else {
        try { events.push({ data: JSON.parse(data) }); } catch { /* skip */ }
      }
    } else if (line.startsWith('event: ')) {
      events.push({ event: line.slice(7).trim() });
    }
  }
  return { events, rest };
}

// ═══════════════════════════════════════════════════════════════════════
//  Base Provider
// ═══════════════════════════════════════════════════════════════════════

export class BaseProvider {
  constructor(name, apiKey, baseUrl) {
    this.name    = name;
    this.apiKey  = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  _headers() {
    return {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
  }

  async _request(path, body, opts = {}) {
    const url = `${this.baseUrl}${path}`;
    return fetchWithRetry(
      () => httpsRequest(url, { method: 'POST', headers: this._headers(), ...opts }, body),
      { reqId: `${this.name}:${path}` }
    );
  }

  async _streamRequest(path, body) {
    const url = `${this.baseUrl}${path}`;
    return fetchStream(
      url,
      { method: 'POST', headers: this._headers() },
      body,
      globalSemaphore
    );
  }

  /**
   * Non-streaming chat completion. Returns OpenAI-shaped response.
   * @abstract
   */
  async chatCompletion(openaiBody) {
    throw new Error(`${this.name}: chatCompletion not implemented`);
  }

  /**
   * Streaming chat completion. Calls onChunk(oaiChunk) for each delta.
   * @abstract
   */
  async chatCompletionStream(openaiBody, onChunk) {
    throw new Error(`${this.name}: chatCompletionStream not implemented`);
  }
}

export { httpsRequest, fetchWithRetry, fetchStream };
