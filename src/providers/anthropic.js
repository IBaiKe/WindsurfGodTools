/**
 * [INPUT]: base.js 基类, tool-conversion.js 双向协议转换, config.js
 * [OUTPUT]: AnthropicProvider — 直连 Anthropic /v1/messages API
 * [POS]: providers/ 中最核心的 provider，支撑 Claude Code 直连
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { BaseProvider, parseSSELines } from './base.js';
import { config, log } from '../config.js';
import {
  convertOpenAIBodyToAnthropic,
  convertAnthropicResponseToOpenAI,
  genCallId,
} from '../tool-conversion.js';

const ANTHROPIC_VERSION = '2023-06-01';

// ═══════════════════════════════════════════════════════════════════════
//  Anthropic stop_reason → OpenAI finish_reason
// ═══════════════════════════════════════════════════════════════════════

const STOP_MAP = {
  end_turn:      'stop',
  max_tokens:    'length',
  tool_use:      'tool_calls',
  stop_sequence: 'stop',
};

// ═══════════════════════════════════════════════════════════════════════
//  AnthropicProvider
// ═══════════════════════════════════════════════════════════════════════

export class AnthropicProvider extends BaseProvider {
  constructor() {
    super('anthropic', config.anthropicApiKey, config.anthropicBaseUrl);
  }

  _headers() {
    return {
      'Content-Type':     'application/json',
      'x-api-key':        this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
  }

  // ── Non-streaming ──────────────────────────────────────────

  async chatCompletion(openaiBody) {
    const anthBody = convertOpenAIBodyToAnthropic({ ...openaiBody, stream: false });
    const result = await this._request('/v1/messages', anthBody);

    if (result.status !== 200) {
      return {
        status: result.status,
        body: {
          error: {
            type:    'upstream_error',
            message: result.body?.error?.message || `Anthropic returned ${result.status}`,
          },
        },
      };
    }
    return { status: 200, body: convertAnthropicResponseToOpenAI(result.body) };
  }

  // ── Streaming ──────────────────────────────────────────────

  async chatCompletionStream(openaiBody, onChunk) {
    const anthBody = convertOpenAIBodyToAnthropic({ ...openaiBody, stream: true });
    const streamResult = await this._streamRequest('/v1/messages', anthBody);

    if (streamResult.status !== 200) {
      const chunks = [];
      for await (const c of streamResult.body) chunks.push(c);
      streamResult.release?.();
      const raw = Buffer.concat(chunks).toString();
      let errMsg = `Anthropic returned ${streamResult.status}`;
      try { errMsg = JSON.parse(raw).error?.message || errMsg; } catch {}
      throw new Error(errMsg);
    }

    const reader = streamResult.body;
    let buf = '';
    const model = openaiBody.model || '';
    const toolCallMap = new Map();
    let toolCallIndex = 0;

    const emitChunk = (delta, finishReason = null, usage = null) => {
      const chunk = {
        id:      'chatcmpl-stream',
        object:  'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      };
      if (usage) chunk.usage = usage;
      onChunk(chunk);
    };

    for await (const raw of reader) {
      const text = typeof raw === 'string' ? raw : raw.toString();
      const { events, rest } = parseSSELines(text, buf);
      buf = rest;

      for (const ev of events) {
        if (ev.done) continue;
        if (!ev.data) continue;
        const d = ev.data;

        if (d.type === 'message_start') {
          emitChunk({ role: 'assistant', content: '' });
          continue;
        }

        if (d.type === 'content_block_start') {
          const block = d.content_block;
          if (block?.type === 'tool_use') {
            const idx = toolCallIndex++;
            toolCallMap.set(d.index, idx);
            emitChunk({
              tool_calls: [{
                index:    idx,
                id:       block.id || genCallId(),
                type:     'function',
                function: { name: block.name, arguments: '' },
              }],
            });
          }
          continue;
        }

        if (d.type === 'content_block_delta') {
          const delta = d.delta;
          if (delta?.type === 'text_delta' && delta.text) {
            emitChunk({ content: delta.text });
          } else if (delta?.type === 'thinking_delta' && delta.thinking) {
            emitChunk({ reasoning_content: delta.thinking });
          } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
            const idx = toolCallMap.get(d.index) ?? 0;
            emitChunk({
              tool_calls: [{ index: idx, function: { arguments: delta.partial_json } }],
            });
          }
          continue;
        }

        if (d.type === 'message_delta') {
          const finish = STOP_MAP[d.delta?.stop_reason] || 'stop';
          const usage = d.usage ? {
            prompt_tokens:     d.usage.input_tokens || 0,
            completion_tokens: d.usage.output_tokens || 0,
            total_tokens:      (d.usage.input_tokens || 0) + (d.usage.output_tokens || 0),
          } : null;
          emitChunk({}, finish, usage);
          continue;
        }
      }
    }
    streamResult.release?.();
  }
}
