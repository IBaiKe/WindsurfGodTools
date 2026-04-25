/**
 * [INPUT]: 无外部依赖，纯数据转换
 * [OUTPUT]: OpenAI ↔ Anthropic 双向工具调用协议转换，Responses API 格式转换，usage 格式映射
 * [POS]: 协议转换核心层，被 providers/*.js, handlers/messages.js, handlers/responses.js 消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { randomUUID } from 'node:crypto';

// ═══════════════════════════════════════════════════════════════════════
//  ID generators
// ═══════════════════════════════════════════════════════════════════════

export const genMsgId     = () => 'msg_'   + randomUUID().replace(/-/g, '').slice(0, 24);
export const genToolUseId = () => 'toolu_' + randomUUID().replace(/-/g, '').slice(0, 22);
export const genCallId    = () => 'call_'  + randomUUID().replace(/-/g, '').slice(0, 24);
export const genRespId    = () => 'resp_'  + randomUUID().replace(/-/g, '').slice(0, 24);

// ═══════════════════════════════════════════════════════════════════════
//  OpenAI → Anthropic
// ═══════════════════════════════════════════════════════════════════════

export function convertToolsToAnthropic(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools
    .filter(t => t?.type === 'function' && t.function)
    .map(t => ({
      name:         t.function.name,
      description:  t.function.description || '',
      input_schema: t.function.parameters || { type: 'object', properties: {} },
    }));
}

export function convertToolChoiceToAnthropic(tc) {
  if (!tc) return undefined;
  if (tc === 'auto')     return { type: 'auto' };
  if (tc === 'required') return { type: 'any' };
  if (tc === 'none')     return undefined;
  if (tc?.type === 'function' && tc.function?.name) {
    return { type: 'tool', name: tc.function.name };
  }
  return undefined;
}

/**
 * OpenAI messages[] → { system: string, messages: AnthropicMessage[] }
 */
export function convertMessagesToAnthropic(oaiMessages) {
  const systemParts = [];
  const msgs = [];

  for (const m of oaiMessages) {
    if (m.role === 'system' || m.role === 'developer') {
      systemParts.push(typeof m.content === 'string' ? m.content : contentToString(m.content));
      continue;
    }

    if (m.role === 'user') {
      const blocks = [];
      if (typeof m.content === 'string') {
        blocks.push({ type: 'text', text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part.type === 'text')      blocks.push({ type: 'text', text: part.text || '' });
          else if (part.type === 'image_url' && part.image_url?.url) {
            const url = part.image_url.url;
            const m64 = url.match(/^data:(image\/\w+);base64,(.+)$/);
            if (m64) {
              blocks.push({ type: 'image', source: { type: 'base64', media_type: m64[1], data: m64[2] } });
            } else {
              blocks.push({ type: 'image', source: { type: 'url', url } });
            }
          }
        }
      }
      msgs.push({ role: 'user', content: blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks });
      continue;
    }

    if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: typeof m.content === 'string' ? m.content : contentToString(m.content) });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          let input = {};
          try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = { _raw: tc.function?.arguments }; }
          blocks.push({
            type:  'tool_use',
            id:    tc.id || genToolUseId(),
            name:  tc.function?.name || 'unknown',
            input,
          });
        }
      }
      msgs.push({ role: 'assistant', content: blocks });
      continue;
    }

    if (m.role === 'tool') {
      // OpenAI tool messages → Anthropic tool_result in user turn
      const lastMsg = msgs[msgs.length - 1];
      const result = {
        type:        'tool_result',
        tool_use_id: m.tool_call_id || '',
        content:     typeof m.content === 'string' ? m.content : contentToString(m.content),
      };
      if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content) && lastMsg.content.every(b => b.type === 'tool_result')) {
        lastMsg.content.push(result);
      } else {
        msgs.push({ role: 'user', content: [result] });
      }
      continue;
    }
  }

  // Enforce role alternation
  const merged = [];
  for (const m of msgs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) {
      const prevContent = Array.isArray(prev.content) ? prev.content : [{ type: 'text', text: prev.content || '' }];
      const curContent  = Array.isArray(m.content)    ? m.content    : [{ type: 'text', text: m.content || '' }];
      prev.content = [...prevContent, ...curContent];
    } else {
      merged.push({ ...m });
    }
  }

  return {
    system:   systemParts.join('\n\n') || undefined,
    messages: merged,
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  Anthropic → OpenAI (mirrors messages.js existing logic)
// ═══════════════════════════════════════════════════════════════════════

export function convertToolsToOpenAI(anthropicTools) {
  if (!Array.isArray(anthropicTools)) return undefined;
  const out = [];
  for (const t of anthropicTools) {
    if (!t?.name) continue;
    if (t.type && t.type !== 'custom' && !t.input_schema) continue;
    out.push({
      type: 'function',
      function: {
        name:        t.name,
        description: t.description || '',
        parameters:  t.input_schema || { type: 'object', properties: {} },
      },
    });
  }
  return out.length ? out : undefined;
}

export function convertToolChoiceToOpenAI(tc) {
  if (!tc) return undefined;
  if (typeof tc === 'string') return tc;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any')  return 'required';
  if (tc.type === 'none') return 'none';
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } };
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════
//  Response conversion: Anthropic → OpenAI
// ═══════════════════════════════════════════════════════════════════════

const ANTH_STOP_TO_FINISH = {
  end_turn:   'stop',
  max_tokens: 'length',
  tool_use:   'tool_calls',
};

export function convertAnthropicResponseToOpenAI(anthResp) {
  const texts = [];
  const toolCalls = [];

  for (const block of anthResp.content || []) {
    if (block.type === 'text' && block.text)         texts.push(block.text);
    if (block.type === 'thinking' && block.thinking)  texts.push(`<thinking>${block.thinking}</thinking>`);
    if (block.type === 'tool_use') {
      toolCalls.push({
        id:       block.id || genCallId(),
        type:     'function',
        function: {
          name:      block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  const message = {
    role:    'assistant',
    content: texts.join('') || null,
  };
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id:      'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 24),
    object:  'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model:   anthResp.model || '',
    choices: [{
      index:         0,
      message,
      finish_reason: ANTH_STOP_TO_FINISH[anthResp.stop_reason] || 'stop',
    }],
    usage: {
      prompt_tokens:     anthResp.usage?.input_tokens || 0,
      completion_tokens: anthResp.usage?.output_tokens || 0,
      total_tokens:      (anthResp.usage?.input_tokens || 0) + (anthResp.usage?.output_tokens || 0),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  Response conversion: OpenAI → Anthropic
// ═══════════════════════════════════════════════════════════════════════

const FINISH_TO_STOP = {
  stop:        'end_turn',
  length:      'max_tokens',
  tool_calls:  'tool_use',
};

export function convertOpenAIResponseToAnthropic(oaiResp, model) {
  const choice = oaiResp.choices?.[0];
  const msg = choice?.message || {};
  const content = [];

  if (msg.reasoning_content) {
    content.push({ type: 'thinking', thinking: msg.reasoning_content, signature: '' });
  }
  if (msg.content) content.push({ type: 'text', text: msg.content });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
      content.push({
        type: 'tool_use',
        id:   tc.id || genToolUseId(),
        name: tc.function?.name || 'unknown',
        input,
      });
    }
  }
  if (!content.length) content.push({ type: 'text', text: '' });

  const u = oaiResp.usage || {};
  return {
    id:            genMsgId(),
    type:          'message',
    role:          'assistant',
    content,
    model:         model || oaiResp.model || '',
    stop_reason:   FINISH_TO_STOP[choice?.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens:  u.prompt_tokens || 0,
      output_tokens: u.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens:     0,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  Responses API conversion: ChatCompletion → Responses format
// ═══════════════════════════════════════════════════════════════════════

/**
 * Responses API input (string | array) → OpenAI messages[]
 */
export function convertResponsesInputToMessages(input, instructions) {
  const msgs = [];
  if (instructions) msgs.push({ role: 'system', content: instructions });

  if (typeof input === 'string') {
    msgs.push({ role: 'user', content: input });
    return msgs;
  }
  if (!Array.isArray(input)) {
    msgs.push({ role: 'user', content: String(input ?? '') });
    return msgs;
  }

  for (const item of input) {
    if (typeof item === 'string') {
      msgs.push({ role: 'user', content: item });
      continue;
    }
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'message') {
      const role = item.role === 'developer' ? 'system' : item.role || 'user';
      if (typeof item.content === 'string') {
        msgs.push({ role, content: item.content });
        continue;
      }
      if (Array.isArray(item.content)) {
        const parts = [];
        for (const p of item.content) {
          if (!p || typeof p !== 'object') continue;
          if (p.type === 'input_text' || p.type === 'text') {
            parts.push({ type: 'text', text: p.text || '' });
          } else if (p.type === 'input_image') {
            const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
            if (url) parts.push({ type: 'image_url', image_url: { url, detail: p.detail || p.image_url?.detail || 'auto' } });
          }
        }
        if (parts.length === 1 && parts[0].type === 'text') {
          msgs.push({ role, content: parts[0].text });
        } else if (parts.length) {
          msgs.push({ role, content: parts });
        } else {
          msgs.push({ role, content: '' });
        }
        continue;
      }
      msgs.push({ role, content: String(item.content ?? '') });
      continue;
    }

    if (item.type === 'function_call') {
      msgs.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id:       item.call_id || genCallId(),
          type:     'function',
          function: { name: item.name || '', arguments: item.arguments || '{}' },
        }],
      });
      continue;
    }

    if (item.type === 'function_call_output') {
      msgs.push({
        role:         'tool',
        tool_call_id: item.call_id || '',
        content:      item.output || '',
      });
      continue;
    }

    // reasoning items — encrypted content cannot be decoded by proxy, skip
    if (item.type === 'reasoning') continue;

    // EasyInputMessage — has role but no type
    if (item.role) {
      const role = item.role === 'developer' ? 'system' : item.role;
      msgs.push({ role, content: typeof item.content === 'string' ? item.content : String(item.content ?? '') });
    }
  }
  return msgs;
}

/**
 * Keep only type:"function" tools, drop built-ins
 */
export function filterResponsesTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = tools.filter(t => t?.type === 'function');
  return out.length ? out : undefined;
}

/**
 * OpenAI ChatCompletion → Responses API response object
 */
export function convertUsageToResponses(u) {
  if (!u) return null;
  const input  = u.prompt_tokens     || u.input_tokens  || 0;
  const output = u.completion_tokens || u.output_tokens || 0;
  return {
    input_tokens:  input,
    output_tokens: output,
    total_tokens:  input + output,
    input_tokens_details:  { cached_tokens: u.prompt_tokens_details?.cached_tokens || 0 },
    output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens || 0 },
  };
}

export function convertChatCompletionToResponses(chatResp, reqId) {
  const id = reqId || genRespId();
  const choice = chatResp.choices?.[0];
  const msg = choice?.message || {};
  const output = [];

  // reasoning_content → reasoning output item
  if (msg.reasoning_content) {
    output.push({
      type:    'reasoning',
      id:      genMsgId(),
      content: [{ type: 'reasoning_text', text: msg.reasoning_content }],
    });
  }

  // text → output_text in a message item
  if (msg.content) {
    output.push({
      type:    'message',
      id:      genMsgId(),
      status:  'completed',
      role:    'assistant',
      content: [{ type: 'output_text', text: msg.content, annotations: [] }],
    });
  }

  // tool_calls → function_call items
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      const cid = tc.id || genCallId();
      output.push({
        type:      'function_call',
        id:        cid,
        call_id:   cid,
        name:      tc.function?.name || '',
        arguments: tc.function?.arguments || '{}',
        status:    'completed',
      });
    }
  }

  const incomplete = choice?.finish_reason === 'length';
  return {
    id,
    object:  'response',
    created: chatResp.created || Math.floor(Date.now() / 1000),
    model:   chatResp.model || '',
    status:  incomplete ? 'incomplete' : 'completed',
    ...(incomplete && { incomplete_details: { reason: 'max_output_tokens' } }),
    output,
    usage:   convertUsageToResponses(chatResp.usage),
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  Build Anthropic request body from OpenAI chat completions body
// ═══════════════════════════════════════════════════════════════════════

export function convertOpenAIBodyToAnthropic(oaiBody) {
  const { system, messages } = convertMessagesToAnthropic(oaiBody.messages || []);
  const body = {
    model:      oaiBody.model,
    messages,
    max_tokens: oaiBody.max_tokens || 8192,
  };
  if (system) body.system = system;
  if (typeof oaiBody.temperature === 'number') body.temperature = oaiBody.temperature;
  if (typeof oaiBody.top_p === 'number')       body.top_p = oaiBody.top_p;
  if (oaiBody.stream) body.stream = true;
  if (oaiBody.stop) body.stop_sequences = Array.isArray(oaiBody.stop) ? oaiBody.stop : [oaiBody.stop];

  const tools = convertToolsToAnthropic(oaiBody.tools);
  if (tools) body.tools = tools;
  const tc = convertToolChoiceToAnthropic(oaiBody.tool_choice);
  if (tc) body.tool_choice = tc;

  return body;
}

// ═══════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════

function contentToString(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(p => p?.text || '').filter(Boolean).join('');
  return String(content ?? '');
}
