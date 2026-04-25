/**
 * [INPUT]: base.js 基类, config.js, rate-limit.js
 * [OUTPUT]: GeminiProvider — 直连 Google Gemini generateContent API
 * [POS]: providers/ 中需要格式转换最多的 provider (OpenAI ↔ Gemini)
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { BaseProvider, parseSSELines, httpsRequest, fetchWithRetry, fetchStream, } from './base.js';
import { config } from '../config.js';

// ═══════════════════════════════════════════════════════════════════════
//  OpenAI → Gemini format conversion
// ═══════════════════════════════════════════════════════════════════════

function toGeminiContents(messages) {
  const contents = [];
  let systemInstruction = null;

  for (const m of messages) {
    if (m.role === 'system') {
      systemInstruction = { parts: [{ text: typeof m.content === 'string' ? m.content : '' }] };
      continue;
    }
    const role = m.role === 'assistant' ? 'model' : 'user';
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map(p => p?.text || '').filter(Boolean).join('')
        : String(m.content ?? '');
    if (!text && m.role === 'tool') {
      contents.push({ role: 'user', parts: [{ text: `[Tool result: ${m.tool_call_id}] ${m.content || ''}` }] });
      continue;
    }
    contents.push({ role, parts: [{ text }] });
  }
  return { contents, systemInstruction };
}

function geminiResponseToOpenAI(geminiResp, model) {
  const candidate = geminiResp.candidates?.[0];
  const text = candidate?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';
  const finish = candidate?.finishReason === 'MAX_TOKENS' ? 'length' : 'stop';

  const usage = geminiResp.usageMetadata || {};
  return {
    id:      'chatcmpl-gemini-' + Date.now().toString(36),
    object:  'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finish }],
    usage: {
      prompt_tokens:     usage.promptTokenCount || 0,
      completion_tokens: usage.candidatesTokenCount || 0,
      total_tokens:      usage.totalTokenCount || 0,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  Gemini Provider
// ═══════════════════════════════════════════════════════════════════════

export class GeminiProvider extends BaseProvider {
  constructor() {
    super('gemini', config.geminiApiKey, config.geminiBaseUrl);
  }

  _geminiUrl(model, stream) {
    const action = stream ? 'streamGenerateContent' : 'generateContent';
    const alt = stream ? '?alt=sse&' : '?';
    return `${this.baseUrl}/v1beta/models/${model}:${action}${alt}key=${this.apiKey}`;
  }

  _headers() {
    return { 'Content-Type': 'application/json' };
  }

  async chatCompletion(openaiBody) {
    const model = openaiBody.model || 'gemini-2.5-flash';
    const { contents, systemInstruction } = toGeminiContents(openaiBody.messages || []);
    const geminiBody = { contents };
    if (systemInstruction) geminiBody.systemInstruction = systemInstruction;
    if (openaiBody.max_tokens) {
      geminiBody.generationConfig = { maxOutputTokens: openaiBody.max_tokens };
    }
    if (typeof openaiBody.temperature === 'number') {
      geminiBody.generationConfig = { ...geminiBody.generationConfig, temperature: openaiBody.temperature };
    }

    const url = this._geminiUrl(model, false);
    const result = await fetchWithRetry(
      () => httpsRequest(url, { method: 'POST', headers: this._headers() }, geminiBody),
      { reqId: `gemini:${model}` }
    );

    if (result.status !== 200) {
      return {
        status: result.status,
        body: { error: { type: 'upstream_error', message: `Gemini returned ${result.status}` } },
      };
    }
    return { status: 200, body: geminiResponseToOpenAI(result.body, model) };
  }

  async chatCompletionStream(openaiBody, onChunk) {
    const model = openaiBody.model || 'gemini-2.5-flash';
    const { contents, systemInstruction } = toGeminiContents(openaiBody.messages || []);
    const geminiBody = { contents };
    if (systemInstruction) geminiBody.systemInstruction = systemInstruction;
    if (openaiBody.max_tokens) {
      geminiBody.generationConfig = { maxOutputTokens: openaiBody.max_tokens };
    }

    const url = this._geminiUrl(model, true);
    const streamResult = await fetchStream(url, { method: 'POST', headers: this._headers() }, geminiBody);

    if (streamResult.status !== 200) {
      const chunks = [];
      for await (const c of streamResult.body) chunks.push(c);
      streamResult.release?.();
      throw new Error(`Gemini returned ${streamResult.status}`);
    }

    let buf = '';
    for await (const raw of streamResult.body) {
      const text = typeof raw === 'string' ? raw : raw.toString();
      const { events, rest } = parseSSELines(text, buf);
      buf = rest;
      for (const ev of events) {
        if (ev.done) break;
        if (!ev.data?.candidates?.[0]) continue;
        const part = ev.data.candidates[0].content?.parts?.[0];
        if (part?.text) {
          onChunk({
            id:      'chatcmpl-gemini-stream',
            object:  'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }],
          });
        }
      }
    }
    // final chunk
    onChunk({
      id:      'chatcmpl-gemini-stream',
      object:  'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
    streamResult.release?.();
  }
}
