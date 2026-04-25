/**
 * [INPUT]: package.json 版本号, .env 环境变量
 * [OUTPUT]: config 全局配置对象, log 日志工具, VERSION 版本号
 * [POS]: 全局基础设施，被所有模块依赖，不依赖任何业务模块
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

export const VERSION = JSON.parse(
  readFileSync(resolve(ROOT, 'package.json'), 'utf-8')
).version;

// Load .env file manually (zero dependencies)
function loadEnv() {
  const envPath = resolve(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

loadEnv();

// Derive the default Language Server binary path from the host platform/arch.
// Windsurf ships these filenames inside its tarball. Users can override with
// LS_BINARY_PATH if they keep the binary elsewhere.
function defaultLsBinaryPath() {
  const dir = '/opt/windsurf';
  const { platform, arch } = process;
  // macOS: binaries ship with the .app bundle, but people commonly symlink
  // them to /opt/windsurf as well. Fall through to linux-x64 only if the user
  // didn't vendor the darwin binary.
  if (platform === 'darwin') {
    return `${dir}/language_server_macos_${arch === 'arm64' ? 'arm' : 'x64'}`;
  }
  if (platform === 'win32') {
    return `${dir}\\language_server_windows_x64.exe`;
  }
  // Linux (and anything else unixy)
  return `${dir}/language_server_linux_${arch === 'arm64' ? 'arm' : 'x64'}`;
}

const posInt = (v, d) => { const n = parseInt(v, 10); return n > 0 ? n : d; };

export const config = {
  port: parseInt(process.env.PORT || '3003', 10),
  apiKey: process.env.API_KEY || '',

  codeiumAuthToken: process.env.CODEIUM_AUTH_TOKEN || '',
  codeiumApiKey: process.env.CODEIUM_API_KEY || '',
  codeiumEmail: process.env.CODEIUM_EMAIL || '',
  codeiumPassword: process.env.CODEIUM_PASSWORD || '',

  codeiumApiUrl: process.env.CODEIUM_API_URL || 'https://server.self-serve.windsurf.com',
  defaultModel: process.env.DEFAULT_MODEL || 'claude-4.5-sonnet-thinking',
  maxTokens: parseInt(process.env.MAX_TOKENS || '8192', 10),
  logLevel: process.env.LOG_LEVEL || 'info',

  lsBinaryPath: process.env.LS_BINARY_PATH || defaultLsBinaryPath(),
  lsPort: parseInt(process.env.LS_PORT || '42100', 10),

  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',

  // -- 并发控制 --
  maxConcurrent:      posInt(process.env.MAX_CONCURRENT, 5),
  maxLsConcurrent:    posInt(process.env.MAX_LS_CONCURRENT, 3),
  maxRetries:         posInt(process.env.MAX_RETRIES, 3),
  rateLimitThreshold: posInt(process.env.RATE_LIMIT_THRESHOLD, 2),

  // -- 直连厂商 API --
  anthropicApiKey:   process.env.ANTHROPIC_API_KEY   || '',
  anthropicBaseUrl:  process.env.ANTHROPIC_BASE_URL  || 'https://api.anthropic.com',
  openaiApiKey:      process.env.OPENAI_API_KEY      || '',
  openaiBaseUrl:     process.env.OPENAI_BASE_URL     || 'https://api.openai.com',
  geminiApiKey:      process.env.GEMINI_API_KEY       || '',
  geminiBaseUrl:     process.env.GEMINI_BASE_URL      || 'https://generativelanguage.googleapis.com',
  openrouterApiKey:  process.env.OPENROUTER_API_KEY   || '',
  openrouterBaseUrl: process.env.OPENROUTER_BASE_URL  || 'https://openrouter.ai/api',
};

const levels = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = levels[config.logLevel] ?? 1;

export const log = {
  debug: (...args) => currentLevel <= 0 && console.log('[DEBUG]', ...args),
  info: (...args) => currentLevel <= 1 && console.log('[INFO]', ...args),
  warn: (...args) => currentLevel <= 2 && console.warn('[WARN]', ...args),
  error: (...args) => currentLevel <= 3 && console.error('[ERROR]', ...args),
};
