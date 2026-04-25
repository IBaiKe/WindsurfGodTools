/**
 * [INPUT]: handleChatCompletions 核心管线, tool-conversion.js 格式转换, response-store.js 存储
 * [OUTPUT]: handleResponses — /v1/responses 端点，兼容 Codex CLI / OpenAI Responses API
 * [POS]: handlers/ 中 Responses API 的入口，请求转化为 chat completions 复用现有管线
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { handleChatCompletions } from './chat.js';
import { config, log } from '../config.js';
import {
  convertResponsesInputToMessages,
  filterResponsesTools,
  convertChatCompletionToResponses,
  convertUsageToResponses,
  genRespId,
  genMsgId,
  genCallId,
} from '../tool-conversion.js';
import { responseStore } from '../response-store.js';

// ═══════════════════════════════════════════════════════════════════════
//  Shared: build OpenAI chat completions body from Responses API body
// ═══════════════════════════════════════════════════════════════════════

function resolveInput(body) {
  if (!body.previous_response_id) return body.input;
  const prev = responseStore.get(body.previous_response_id);
  if (!prev || !Array.isArray(prev.output)) return body.input;

  const prevItems = convertOutputToInput(prev.output);
  if (Array.isArray(body.input)) return [...prevItems, ...body.input];
  if (typeof body.input === 'string') return [...prevItems, { type: 'message', role: 'user', content: body.input }];
  return prevItems;
}

function convertOutputToInput(output) {
  const items = [];
  for (const item of output) {
    if (item.type === 'message' && item.role === 'assistant') {
      items.push({
        type: 'message', role: 'assistant',
        content: item.content?.map(c => ({
          type: c.type === 'output_text' ? 'input_text' : c.type,
          text: c.text || '',
        })) || [],
      });
    } else if (item.type === 'function_call') {
      items.push({ type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments });
    } else if (item.type === 'reasoning') {
      items.push({ type: 'reasoning', content: item.content });
    }
  }
  return items;
}

function buildOpenaiBody(body, stream) {
  const input    = resolveInput(body);
  const messages = convertResponsesInputToMessages(input, body.instructions);
  const tools    = filterResponsesTools(body.tools);

  const oai = {
    model:    body.model || config.defaultModel,
    messages,
    stream,
    _source:  'POST /v1/responses',
  };

  if (body.max_output_tokens)                oai.max_tokens = body.max_output_tokens;
  if (typeof body.temperature === 'number')  oai.temperature = body.temperature;
  if (typeof body.top_p === 'number')        oai.top_p = body.top_p;
  if (tools)                                 oai.tools = tools;
  if (body.tool_choice)                      oai.tool_choice = body.tool_choice;
  if (body.parallel_tool_calls === false)     oai.parallel_tool_calls = false;

  // stop sequences
  if (Array.isArray(body.stop))              oai.stop = body.stop;
  else if (typeof body.stop === 'string')    oai.stop = [body.stop];

  // text.format → response_format
  if (body.text?.format) {
    const fmt = body.text.format;
    if (fmt.type === 'json_object')      oai.response_format = { type: 'json_object' };
    else if (fmt.type === 'json_schema') oai.response_format = { type: 'json_schema', json_schema: fmt.json_schema };
  }

  // reasoning.effort → reasoning_effort
  if (body.reasoning?.effort) oai.reasoning_effort = body.reasoning.effort;

  return oai;
}

// ═══════════════════════════════════════════════════════════════════════
//  Non-streaming: Responses API → ChatCompletion → Responses format
// ═══════════════════════════════════════════════════════════════════════

async function handleNonStream(body) {
  const respId   = genRespId();
  const openaiBody = buildOpenaiBody(body, false);

  const result = await handleChatCompletions(openaiBody);
  if (result.status !== 200) {
    return {
      status: result.status,
      body: {
        id: respId, object: 'response', status: 'failed',
        error: result.body?.error || { type: 'api_error', message: 'Unknown error' },
        metadata: body.metadata || null,
      },
    };
  }

  const respBody = convertChatCompletionToResponses(result.body, respId);
  if (body.metadata) respBody.metadata = body.metadata;
  responseStore.set(respId, respBody);
  return { status: 200, body: respBody };
}

// ═══════════════════════════════════════════════════════════════════════
//  Streaming: OpenAI SSE → Responses API semantic events
// ═══════════════════════════════════════════════════════════════════════

/**
 * ResponsesStreamTransform: intercepts OpenAI SSE chunks from
 * handleChatCompletions' streaming handler and emits Responses API
 * semantic events on the real HTTP response.
 *
 * Event flow:
 *   response.created → response.in_progress
 *   → [reasoning: output_item.added → reasoning.delta... → reasoning.done → output_item.done]
 *   → output_item.added → content_part.added
 *   → output_text.delta (repeated) → output_text.done → content_part.done → output_item.done
 *   → [function_call: output_item.added → arguments.delta... → arguments.done → output_item.done]
 *   → response.completed
 */
class ResponsesStreamTransform {
  constructor(realRes, model, respId, metadata) {
    this.real     = realRes;
    this.model    = model;
    this.respId   = respId;
    this.metadata = metadata || null;
    this.output   = [];

    // Sequence counter for all SSE events
    this._seqNum = 0;

    // State tracking
    this._started       = false;
    this._reasoningItem = null;
    this._reasoningText = '';
    this._textItem      = null;
    this._textContent   = '';
    this._funcItems     = [];
    this._funcArgs      = new Map();
    this._outputIdx     = 0;
    this._stopReason    = 'stop';
    this._usage         = null;
    this._buf           = '';

    this.on = (ev, cb) => this.real.on(ev, cb);
  }

  get writableEnded() { return this.real.writableEnded; }

  // ── SSE emission ──────────────────────────────────────────────────

  _emit(event, data) {
    if (this.real.writableEnded) return;
    data.sequence_number = this._seqNum++;
    this.real.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  _ensureStarted() {
    if (this._started) return;
    this._started = true;
    const envelope = {
      id: this.respId, object: 'response', status: 'in_progress',
      model: this.model, output: [], metadata: this.metadata,
    };
    this._emit('response.created',     { type: 'response.created',     response: envelope });
    this._emit('response.in_progress', { type: 'response.in_progress', response: envelope });
  }

  // ── Reasoning output item ─────────────────────────────────────────

  _ensureReasoningItem() {
    if (this._reasoningItem) return;
    const idx = this._outputIdx++;
    this._reasoningItem = {
      type: 'reasoning', id: genMsgId(),
      content: [{ type: 'reasoning_text', text: '' }],
      _idx: idx,
    };
    this._emit('response.output_item.added', {
      type: 'response.output_item.added', output_index: idx,
      item: { type: 'reasoning', id: this._reasoningItem.id, content: [] },
    });
  }

  _closeReasoningItem() {
    if (!this._reasoningItem) return;
    const idx = this._reasoningItem._idx;
    this._reasoningItem.content[0].text = this._reasoningText;
    this._emit('response.reasoning.done', {
      type: 'response.reasoning.done', output_index: idx, content_index: 0,
      text: this._reasoningText,
    });
    const { _idx, ...cleanItem } = this._reasoningItem;
    this._emit('response.output_item.done', {
      type: 'response.output_item.done', output_index: idx, item: cleanItem,
    });
    this.output.push(cleanItem);
    this._reasoningItem = null;
  }

  // ── Text output item ──────────────────────────────────────────────

  _ensureTextItem() {
    this._closeReasoningItem();
    if (this._textItem) return;
    const idx = this._outputIdx++;
    this._textItem = {
      type: 'message', id: genMsgId(), status: 'in_progress',
      role: 'assistant',
      content: [{ type: 'output_text', text: '', annotations: [] }],
      _idx: idx,
    };
    this._emit('response.output_item.added', {
      type: 'response.output_item.added', output_index: idx, item: {
        type: 'message', id: this._textItem.id, status: 'in_progress',
        role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }],
      },
    });
    this._emit('response.content_part.added', {
      type: 'response.content_part.added', output_index: idx, content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  }

  _closeTextItem() {
    if (!this._textItem) return;
    const idx = this._textItem._idx;
    this._emit('response.output_text.done', {
      type: 'response.output_text.done', output_index: idx, content_index: 0,
      text: this._textContent,
    });
    this._emit('response.content_part.done', {
      type: 'response.content_part.done', output_index: idx, content_index: 0,
      part: { type: 'output_text', text: this._textContent, annotations: [] },
    });
    this._textItem.content[0].text = this._textContent;
    this._textItem.status = 'completed';
    const { _idx, ...cleanItem } = this._textItem;
    this._emit('response.output_item.done', {
      type: 'response.output_item.done', output_index: idx, item: cleanItem,
    });
    this.output.push(cleanItem);
    this._textItem = null;
  }

  // ── Chunk processing ──────────────────────────────────────────────

  _handleChunk(chunk) {
    const delta  = chunk.choices?.[0]?.delta || {};
    const finish = chunk.choices?.[0]?.finish_reason;

    // Reasoning delta (thinking models)
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length) {
      this._ensureReasoningItem();
      this._reasoningText += delta.reasoning_content;
      this._emit('response.reasoning.delta', {
        type: 'response.reasoning.delta',
        output_index: this._reasoningItem._idx, content_index: 0,
        delta: delta.reasoning_content,
      });
    }

    // Text delta
    if (typeof delta.content === 'string' && delta.content.length) {
      this._ensureTextItem();
      this._textContent += delta.content;
      this._emit('response.output_text.delta', {
        type: 'response.output_text.delta',
        output_index: this._textItem._idx, content_index: 0,
        delta: delta.content,
      });
    }

    // Tool call deltas
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const oaiIdx = tc.index ?? 0;
        if (!this._funcArgs.has(oaiIdx)) {
          this._closeTextItem();
          const idx = this._outputIdx++;
          const callId = tc.id || genCallId();
          const name = tc.function?.name || '';
          this._funcArgs.set(oaiIdx, { idx, callId, name, args: '' });
          this._emit('response.output_item.added', {
            type: 'response.output_item.added', output_index: idx,
            item: {
              type: 'function_call', id: callId, call_id: callId,
              name, arguments: '', status: 'in_progress',
            },
          });
        }
        if (tc.function?.arguments) {
          const info = this._funcArgs.get(oaiIdx);
          info.args += tc.function.arguments;
          this._emit('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            output_index: info.idx, delta: tc.function.arguments,
          });
        }
      }
    }

    if (chunk.usage) this._usage = chunk.usage;
    if (finish) this._stopReason = finish;
  }

  // ── Finish / error ────────────────────────────────────────────────

  _finish() {
    this._closeReasoningItem();
    this._closeTextItem();

    // Close all function call items
    for (const [, info] of this._funcArgs) {
      this._emit('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        output_index: info.idx, arguments: info.args,
      });
      const item = {
        type: 'function_call', id: info.callId, call_id: info.callId,
        name: info.name, arguments: info.args, status: 'completed',
      };
      this._emit('response.output_item.done', {
        type: 'response.output_item.done', output_index: info.idx, item,
      });
      this.output.push(item);
    }

    const incomplete = this._stopReason === 'length';
    const completed = {
      id: this.respId, object: 'response',
      status: incomplete ? 'incomplete' : 'completed',
      model: this.model, output: this.output,
      usage: convertUsageToResponses(this._usage),
      metadata: this.metadata,
      ...(incomplete && { incomplete_details: { reason: 'max_output_tokens' } }),
    };
    this._emit('response.completed', { type: 'response.completed', response: completed });
    responseStore.set(this.respId, completed);
    if (!this.real.writableEnded) this.real.end();
  }

  _emitFailed(message) {
    this._ensureStarted();
    this._closeReasoningItem();
    this._closeTextItem();
    const resp = {
      id: this.respId, object: 'response', status: 'failed',
      model: this.model, output: this.output,
      error: { type: 'server_error', message },
      metadata: this.metadata,
    };
    this._emit('response.failed', { type: 'response.failed', response: resp });
    if (!this.real.writableEnded) this.real.end();
  }

  // ── Write interface (called by handleChatCompletions handler) ─────

  write(chunk) {
    if (this.real.writableEnded) return true;
    this._ensureStarted();

    this._buf += chunk.toString();
    let nlIdx;
    while ((nlIdx = this._buf.indexOf('\n\n')) !== -1) {
      const raw = this._buf.slice(0, nlIdx);
      this._buf = this._buf.slice(nlIdx + 2);
      this._parseSseEvent(raw);
    }
    return true;
  }

  _parseSseEvent(raw) {
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith(': '))     continue;
      if (line.startsWith('data: ')) dataLines.push(line.slice(6));
    }
    if (!dataLines.length) return;
    const dataStr = dataLines.join('\n');
    if (dataStr === '[DONE]') { this._finish(); return; }
    try { this._handleChunk(JSON.parse(dataStr)); } catch { /* skip unparseable */ }
  }

  end() { if (!this.real.writableEnded) this._finish(); }
  setHeader() {}
  writeHead() {}
}

// ═══════════════════════════════════════════════════════════════════════
//  Public entry
// ═══════════════════════════════════════════════════════════════════════

export async function handleResponses(body) {
  if (!body || (!body.input && body.input !== '')) {
    return {
      status: 400,
      body: { error: { message: 'input is required', type: 'invalid_request' } },
    };
  }

  const stream = !!body.stream;
  const model  = body.model || config.defaultModel;
  log.info(`Responses: model=${model} stream=${stream} input_type=${typeof body.input}`);

  if (!stream) return handleNonStream(body);

  // ── Streaming path ──
  const respId     = genRespId();
  const openaiBody = buildOpenaiBody(body, true);

  const result = await handleChatCompletions(openaiBody);
  if (result.status !== 200 || !result.stream) {
    return {
      status: result.status,
      body: {
        id: respId, object: 'response', status: 'failed',
        error: result.body?.error || { type: 'api_error', message: 'Upstream error' },
        metadata: body.metadata || null,
      },
    };
  }

  return {
    status: 200, stream: true,
    headers: { 'Content-Type': 'text/event-stream' },
    async handler(realRes) {
      const wrapper = new ResponsesStreamTransform(realRes, model, respId, body.metadata);
      wrapper._ensureStarted();
      try {
        await result.handler(wrapper);
      } catch (err) {
        log.error(`responses: stream handler error: ${err.message}`);
        wrapper._emitFailed(err.message);
      }
    },
  };
}
