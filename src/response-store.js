/**
 * [INPUT]: 无外部依赖
 * [OUTPUT]: responseStore — 内存级 Response 存储，支持 TTL 过期和容量上限
 * [POS]: 支撑 Responses API 的 previous_response_id / GET / DELETE
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const TTL_MS      = 30 * 60 * 1000;
const MAX_ENTRIES = 200;

class ResponseStore {
  constructor() { this._store = new Map(); }

  set(id, response) {
    if (!id || !response) return;
    this._store.set(id, { value: response, expiresAt: Date.now() + TTL_MS });
    while (this._store.size > MAX_ENTRIES) {
      const oldest = this._store.keys().next().value;
      this._store.delete(oldest);
    }
  }

  get(id) {
    const entry = this._store.get(id);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) { this._store.delete(id); return null; }
    return entry.value;
  }

  delete(id) { return this._store.delete(id); }
  get size() { return this._store.size; }
}

export const responseStore = new ResponseStore();
