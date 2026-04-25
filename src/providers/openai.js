/**
 * [INPUT]: base.js 基类, config.js
 * [OUTPUT]: OpenAIProvider — 直连 OpenAI /v1/chat/completions API
 * [POS]: providers/ 中格式最轻量的 provider，请求/响应天然匹配 OpenAI 协议
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { BaseProvider, parseSSELines } from './base.js';
import { config } from '../config.js';

// ═══════════════════════════════════════════════════════════════════════
//  OpenAI Provider — thin passthrough
// ═══════════════════════════════════════════════════════════════════════

export class OpenAIProvider extends BaseProvider {
  constructor() {
    super('openai', config.openaiApiKey, config.openaiBaseUrl);
  }

  async chatCompletion(openaiBody) {
    return this._request('/v1/chat/completions', { ...openaiBody, stream: false });
  }

  async chatCompletionStream(openaiBody, onChunk) {
    const body = {
      ...openaiBody,
      stream: true,
      stream_options: { include_usage: true },
    };
    const streamResult = await this._streamRequest('/v1/chat/completions', body);

    if (streamResult.status !== 200) {
      const chunks = [];
      for await (const c of streamResult.body) chunks.push(c);
      streamResult.release?.();
      const raw = Buffer.concat(chunks).toString();
      let errMsg = `OpenAI returned ${streamResult.status}`;
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

  // OpenAI also natively supports /v1/responses — passthrough
  async responsesRequest(body, stream) {
    if (stream) return this._streamRequest('/v1/responses', body);
    return this._request('/v1/responses', body);
  }
}
