/**
 * [INPUT]: config.js 厂商 API Key, models.js 模型目录, providers/*.js 厂商客户端
 * [OUTPUT]: detectProvider, getProviderInstance, routeDirectProvider
 * [POS]: 多模型路由核心，决定请求走 Windsurf LS 还是直连厂商 API
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { config, log } from './config.js';
import { getModelInfo } from './models.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider }    from './providers/openai.js';
import { GeminiProvider }    from './providers/gemini.js';
import { OpenRouterProvider } from './providers/openrouter.js';

// ═══════════════════════════════════════════════════════════════════════
//  Provider detection — Windsurf 目录优先，兜底直连
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param {string} modelKey — resolved model key
 * @returns {'windsurf'|'anthropic'|'openai'|'gemini'|'openrouter'}
 */
export function detectProvider(modelKey) {
  const info = getModelInfo(modelKey);
  if (info && (info.modelUid || info.enumValue > 0)) return 'windsurf';

  const m = (modelKey || '').toLowerCase();
  if (m.startsWith('claude') && config.anthropicApiKey)    return 'anthropic';
  if ((m.startsWith('gpt-') || m.startsWith('o1-') || m.startsWith('o3-') || m.startsWith('o4-')) && config.openaiApiKey) return 'openai';
  if (m.startsWith('gemini') && config.geminiApiKey)       return 'gemini';
  if (m.includes('/') && config.openrouterApiKey)          return 'openrouter';

  return 'windsurf';
}

// ═══════════════════════════════════════════════════════════════════════
//  Provider instances — lazy singleton
// ═══════════════════════════════════════════════════════════════════════

const _cache = {};

export function getProviderInstance(modelKey) {
  const provider = detectProvider(modelKey);
  if (provider === 'windsurf') return null;

  if (!_cache[provider]) {
    switch (provider) {
      case 'anthropic':  _cache[provider] = new AnthropicProvider();  break;
      case 'openai':     _cache[provider] = new OpenAIProvider();     break;
      case 'gemini':     _cache[provider] = new GeminiProvider();     break;
      case 'openrouter': _cache[provider] = new OpenRouterProvider(); break;
    }
  }
  return _cache[provider];
}

// ═══════════════════════════════════════════════════════════════════════
//  Route through direct provider
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param {BaseProvider} provider
 * @param {object} openaiBody
 * @param {boolean} stream
 * @returns handler result matching chat.js return shape
 */
export async function routeDirectProvider(provider, openaiBody, stream) {
  const model = openaiBody.model || '';
  log.info(`router: ${provider.name} direct → model=${model} stream=${stream}`);

  if (!stream) {
    try {
      const result = await provider.chatCompletion(openaiBody);
      return { status: result.status, body: result.body };
    } catch (err) {
      log.error(`router: ${provider.name} non-stream error: ${err.message}`);
      return {
        status: 502,
        body: { error: { type: 'upstream_error', message: err.message } },
      };
    }
  }

  // Streaming — return handler function matching chat.js convention
  return {
    status: 200,
    stream: true,
    headers: { 'Content-Type': 'text/event-stream' },
    async handler(res) {
      try {
        await provider.chatCompletionStream(openaiBody, (chunk) => {
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
        });
        if (!res.writableEnded) {
          res.write('data: [DONE]\n\n');
          res.end();
        }
      } catch (err) {
        log.error(`router: ${provider.name} stream error: ${err.message}`);
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({
            error: { type: 'upstream_error', message: err.message },
          })}\n\n`);
          res.end();
        }
      }
    },
  };
}
