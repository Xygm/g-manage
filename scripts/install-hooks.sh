#!/usr/bin/env bash
# 一键安装本地 Git pre-commit 守护钩子：
# 提交前自动拦截前端语义令牌违规、漏构建 web/ 嵌入产物以及 Go 语法/守护测试错误。
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
hook_file="$repo_root/.git/hooks/pre-commit"

cat >"$hook_file" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

staged="$(git diff --cached --name-only)"

if echo "$staged" | grep -q '^frontend/src/'; then
  if ! echo "$staged" | grep -q '^web/'; then
    echo "✖ [pre-commit] 检测到暂存区修改了 frontend/src/，但未包含编译后的 web/ 产物。" >&2
    echo "  请先运行：npm --prefix frontend run build && git add web/" >&2
    exit 1
  fi
fi

echo "→ [pre-commit] 正在校验设计美学与工程守护规则 (guardrails_test.go)…"
go test -run '^Test(DesignTokenPurity|DarkThemeTokenParity|MotionAndUXGuardrails|EmbeddedWebAssetsIntegrity)$' .
EOF

chmod +x "$hook_file"
echo "✓ 已安装 pre-commit 守护钩子：$hook_file"
