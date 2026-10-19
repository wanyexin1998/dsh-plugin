#!/usr/bin/env bash
# tools/precommit.sh — dsh-data-ide 提交前自检（AGENTS.md §5）
# 用法：pnpm precommit   或   bash tools/precommit.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NODE="node"
VITEST="$NODE node_modules/vitest/vitest.mjs"
# 覆盖率必须经 tools/run-coverage.mjs：它给子进程清掉 NODE_OPTIONS，
# 否则 vitest 清理 coverage/ 时会被 safe-delete 垫片拦成 genie-trash 超时。
COVERAGE="$NODE tools/run-coverage.mjs"
fail() { echo "❌ $*"; exit 1; }
step() { echo "▶ $*"; }

# 0) 本机环境：WorkBuddy 注入的 NODE_OPTIONS（node-brokered-fs / language shim）会拦截
#    文件写入并让 pnpm 在 node_modules 内 rename 报 ERR_PNPM_EPERM。构建与测试一律清掉它。
unset NODE_OPTIONS

# 1) 构建（同时产出 tsc 声明；宿主包装格式由 build.mjs 保证）
step "build（client 半必须是 __ModuleLoader__ 工厂产物）"
$NODE packages/client/ui-sql-workbench/build.mjs >/dev/null || fail "构建失败"

# 2) 浏览器半产物契约：classic script + __ModuleLoader__，且只依赖壳模块表里的 react
step "产物契约检查"
grep -q "window.__ModuleLoader__.load" packages/client/ui-sql-workbench/lib/client.js \
  || fail "lib/client.js 未通过 window.__ModuleLoader__.load 注册"
if grep -qE 'require\("(@deepseek-ai/|react/)' packages/client/ui-sql-workbench/lib/client.js; then
  fail "lib/client.js 引用了宿主模块表以外的依赖（只允许 react / react-dom）"
fi

# 3) 测试 + per-file 100% 覆盖率
step "vitest + coverage（per-file 100%）"
$COVERAGE --passWithNoTests || fail "测试未全绿或覆盖率未达标"

# 4) UI：组件样式只用语义 token，禁硬编码色、主题选择器与滚动条选择器
step "样式检查（token / 主题选择器 / 滚动条）"
if grep -rEn "#[0-9a-fA-F]{3,6}\b" --include="*.css" packages/ 2>/dev/null; then
  fail "组件 CSS 出现硬编码颜色，必须用 --dsw-alias-* token"
fi
# 只认真正的选择器（后接 { 的主题属性选择器），注释里提到它是允许的
if grep -rEn "\[data-ds-(dark|light)-theme\][^{]*\{" --include="*.css" packages/ 2>/dev/null; then
  fail "组件 CSS 禁用主题选择器"
fi
if grep -rEn "::-webkit-scrollbar" --include="*.css" packages/ 2>/dev/null; then
  fail "组件 CSS 禁写滚动条选择器，改用 --dsh-scrollbar-* 变量 rebind"
fi

# 5) 禁跨包 @deepseek-ai/* value import（purity gate 在外部仓的等价物）
step "跨包 value import 检查"
if grep -rEnP "^\s*import\s+(?!type\b)[^;]*from\s+'@deepseek-ai/" --include="*.ts" --include="*.tsx" packages/ 2>/dev/null; then
  fail "存在跨包 @deepseek-ai/* value import（服务应经 Cordis ctx 提供）"
fi

# 6) 兼容性门禁：不得声明 @deepseek-ai/dsh* peerDependencies（否则整包被跳过）
step "peerDependencies 门禁检查"
if grep -A6 '"peerDependencies"' packages/client/ui-sql-workbench/package.json 2>/dev/null | grep -q "@deepseek-ai/dsh"; then
  fail "package.json 出现 @deepseek-ai/dsh* peerDeps，0.1.7 会判定不兼容并跳过整包"
fi

echo "✅ precommit 自检通过"
