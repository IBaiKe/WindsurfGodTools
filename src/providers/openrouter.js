/**
 * [INPUT]: base.js 基类, config.js
 * [OUTPUT]: OpenRouterProvider — OpenAI 兼容，直连 OpenRouter API
 * [POS]: providers/ 中最薄的封装，OpenRouter 本身是 OpenAI 兼容协议
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { BaseProvider, parseSSELines } from './base.js';
import { config } from '../config.js';

// ═══════════════════════════════════════════════════════════════════════
//  OpenRouter Provider
// ═══════════════════════════════════════════════════════════════════════

export class OpenRouterProvider extends BaseProvider {
  constructor() {
    super('openrouter', config.openrouterApiKey, config.openrouterBaseUrl);
  }

  _headers() {
    return {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      'HTTP-Referer':  'https://github.com/WindsurfGodTools',
      'X-Title':       'WindsurfGodTools',
    };
  }

  async chatCompletion(openaiBody) {
    return this._request('/v1/chat/completions', { ...openaiBody, stream: false });
  }

  async chatCompletionStream(openaiBody, onChunk) {
    const body = { ...openaiBody, stream: true };
    const streamResult = await this._streamRequest('/v1/chat/completions', body);

    if (streamResult.status !== 200) {
      const chunks = [];
      for await (const c of streamResult.body) chunks.push(c);
      streamResult.release?.();
      const raw = Buffer.concat(chunks).toString();
      let errMsg = `OpenRouter returned ${streamResult.status}`;
      try { errMsg = JSON.parse(raw).error?.message || errMsg; } catch {}
      throw new Error(errMsg);
    }

    let buf = '';
    for await (const raw of streamResult.body) {
      const text = typeof raw === 'string' ? raw : raw.toString();
      const { events, rest } = parseSSELines(text, buf);
      buf = rest;
      for (const ev of events) {
        if (ev.done) break;
        if (ev.data) onChunk(ev.data);
      }
    }
    streamResult.release?.();
  }
}
