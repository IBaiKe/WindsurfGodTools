#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# WindsurfGodTools — 零停机更新脚本
# 自动检测进程管理器 (PM2 / systemd / Docker)，
# 拉取最新代码，重启服务。
# ─────────────────────────────────────────────────────
set -euo pipefail

# ── 颜色 ───────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; NC='\033[0m'

info()  { echo -e "${GREEN}✅ $*${NC}"; }
warn()  { echo -e "${YELLOW}⚠️  $*${NC}"; }
err()   { echo -e "${RED}❌ $*${NC}"; }
step()  { echo -e "${CYAN}── $* ──${NC}"; }

# ── 定位项目根目录 ─────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

echo "╔══════════════════════════════════════════╗"
echo "║  WindsurfGodTools Updater                 ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  项目目录: $PROJECT_DIR"
echo ""

# ── 前置检查 ───────────────────────────────────────
step "前置检查"

if ! command -v git &>/dev/null; then
  err "git 未安装"; exit 1
fi

if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  err "当前目录不是 git 仓库"; exit 1
fi

if ! command -v node &>/dev/null; then
  err "Node.js 未安装"; exit 1
fi

OLD_VERSION=$(node -e "import('./src/index.js').then(m=>console.log(m.VERSION))" 2>/dev/null || echo "unknown")
OLD_COMMIT=$(git rev-parse --short HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
info "当前: v${OLD_VERSION} @ ${OLD_COMMIT} (${BRANCH})"

# ── 检查本地修改 ───────────────────────────────────
if [ -n "$(git status --porcelain)" ]; then
  warn "工作区有未提交的修改:"
  git status --short
  echo ""
  read -p "  是否 stash 后继续? [y/N] " yn
  if [[ "$yn" =~ ^[Yy]$ ]]; then
    git stash push -m "update.sh auto-stash $(date +%Y%m%d-%H%M%S)"
    info "已 stash"
  else
    err "请先处理未提交修改"; exit 1
  fi
fi

# ── 拉取最新代码 ───────────────────────────────────
step "拉取最新代码"

git fetch origin "$BRANCH" --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ]; then
  info "已是最新版本，无需更新"
  exit 0
fi

BEHIND=$(git rev-list --count HEAD.."origin/$BRANCH")
echo "  远程领先 $BEHIND 个提交"
git log --oneline HEAD.."origin/$BRANCH" | head -10
[ "$BEHIND" -gt 10 ] && echo "  ... 及更多"
echo ""

git pull --ff-only origin "$BRANCH"
NEW_COMMIT=$(git rev-parse --short HEAD)
NEW_VERSION=$(node -e "import('./src/index.js').then(m=>console.log(m.VERSION))" 2>/dev/null || echo "unknown")
info "已更新: v${NEW_VERSION} @ ${NEW_COMMIT}"

# ── 语法检查 ───────────────────────────────────────
step "语法检查"

SYNTAX_OK=true
while IFS= read -r -d '' f; do
  if ! node --check "$f" 2>/dev/null; then
    err "语法错误: $f"
    SYNTAX_OK=false
  fi
done < <(find src -name '*.js' -type f -print0)

if [ "$SYNTAX_OK" = false ]; then
  err "语法检查失败，回滚到 $OLD_COMMIT"
  git reset --hard "$OLD_COMMIT"
  exit 1
fi
info "全部 .js 文件语法检查通过"

# ── .env 新变量检测 ────────────────────────────────
if [ -f .env ] && [ -f .env.example ]; then
  MISSING=""
  while IFS= read -r line; do
    key="${line%%=*}"
    [ -z "$key" ] && continue
    [[ "$key" =~ ^# ]] && continue
    if ! grep -q "^${key}=" .env 2>/dev/null; then
      MISSING="${MISSING}  ${line}\n"
    fi
  done < .env.example
  if [ -n "$MISSING" ]; then
    warn ".env.example 中有新变量未配置:"
    echo -e "$MISSING"
  fi
fi

# ── 检测进程管理器并重启 ───────────────────────────
step "重启服务"

RESTARTED=false

# Docker
if [ -f docker-compose.yml ] && command -v docker &>/dev/null; then
  CONTAINER=$(docker compose ps --quiet 2>/dev/null || true)
  if [ -n "$CONTAINER" ]; then
    echo "  检测到 Docker Compose 运行中"
    docker compose up -d --build
    info "Docker 容器已重建"
    RESTARTED=true
  fi
fi

# PM2
if [ "$RESTARTED" = false ] && command -v pm2 &>/dev/null; then
  PM2_ID=$(pm2 jlist 2>/dev/null | node -e "
    let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
      try{const a=JSON.parse(d);const p=a.find(x=>x.pm2_env?.pm_exec_path?.endsWith('src/index.js'));
      if(p)console.log(p.pm_id)}catch{}
    })" 2>/dev/null || true)
  if [ -n "$PM2_ID" ]; then
    echo "  检测到 PM2 进程 (id=$PM2_ID)"
    PM2_NAME=$(pm2 jlist 2>/dev/null | node -e "
      let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
        try{const a=JSON.parse(d);const p=a.find(x=>x.pm_id===$PM2_ID);
        if(p)console.log(p.name)}catch{}
      })" 2>/dev/null || true)
    PM2_NAME="${PM2_NAME:-windsurf-api}"
    # PM2 restart 在部分环境会残留旧进程，用 delete + start 更安全
    pm2 stop "$PM2_ID" 2>/dev/null || true
    pm2 delete "$PM2_ID" 2>/dev/null || true
    # 释放可能残留的端口占用
    fuser -k 3003/tcp 2>/dev/null || true
    sleep 1
    pm2 start src/index.js --name "$PM2_NAME" --cwd "$PROJECT_DIR"
    info "PM2 服务已重启 ($PM2_NAME)"
    RESTARTED=true
  fi
fi

# systemd
if [ "$RESTARTED" = false ] && command -v systemctl &>/dev/null; then
  if systemctl is-active --quiet windsurfgodtools 2>/dev/null; then
    echo "  检测到 systemd 服务"
    sudo systemctl restart windsurfgodtools
    info "systemd 服务已重启"
    RESTARTED=true
  fi
fi

if [ "$RESTARTED" = false ]; then
  warn "未检测到运行中的服务管理器 (Docker/PM2/systemd)"
  echo "  请手动重启:"
  echo "    node src/index.js"
fi

# ── 健康检查 ───────────────────────────────────────
if [ "$RESTARTED" = true ]; then
  step "健康检查"
  PORT="${PORT:-3003}"
  HEALTHY=false
  for i in $(seq 1 10); do
    if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
      HEALTHY=true
      break
    fi
    sleep 1
  done
  if [ "$HEALTHY" = true ]; then
    info "服务健康 (http://127.0.0.1:${PORT}/health)"
  else
    warn "健康检查超时 — 请手动确认服务状态"
  fi
fi

# ── 完成 ───────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════"
echo "  更新完成: v${OLD_VERSION} → v${NEW_VERSION}"
echo "  提交:     ${OLD_COMMIT} → ${NEW_COMMIT}"
echo "  Dashboard: http://127.0.0.1:${PORT:-3003}/dashboard"
echo "════════════════════════════════════════════"
