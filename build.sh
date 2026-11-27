#!/usr/bin/env bash
# 在 Linux/WSL 上交叉编译 Windows 桌面版：生成 dist/g-manage.exe（带图标，需要 mingw-w64 的 windres）。
# 可选参数：复制到的 Windows 目录（WSL 路径），如 ./build.sh /mnt/e/桌面
# 目标位置的程序正在运行时，会先把它关掉再覆盖。
# 直接从 WSL 复制过去的文件不带「来自网络」标记，Windows 不会弹 SmartScreen 拦截。
set -euo pipefail
cd "$(dirname "$0")"
GO="${GO:-go}"
WINDRES="${WINDRES:-x86_64-w64-mingw32-windres}"

if [ "${SKIP_FRONTEND:-}" = 1 ]; then
	echo "跳过前端构建，使用现有的 web/"
elif [ -d frontend/node_modules ]; then
	npm --prefix frontend run build
fi

mkdir -p dist
name="g-manage.exe"

# 图标：tools/mkicon 把 assets/icon.png 缩成 app.ico，windres 编成 .syso，go build 自动链接进 exe，编完删掉。
tmp=$(mktemp -d)
syso=rsrc_windows_amd64.syso
trap 'rm -rf "$tmp" "$syso"' EXIT
"$GO" run tools/mkicon/main.go "$tmp"
echo '1 ICON "app.ico"' >"$tmp/app.rc" # 编号对应 ui_windows.go 的 appIconID
(cd "$tmp" && "$WINDRES" -O coff -i app.rc -o app.syso)
mv "$tmp/app.syso" "$syso"

GOOS=windows GOARCH=amd64 CGO_ENABLED=0 "$GO" build -trimpath -ldflags "-s -w -H windowsgui" -o "dist/$name" .
echo "已生成 dist/$name"

if [ $# -gt 0 ]; then
	dest="$1/$name"
	if [ -e "$dest" ]; then
		winpath=$(wslpath -w "$dest")
		# 按完整路径匹配，只关这一个程序。
		powershell.exe -NoProfile -Command "
			\$p = Get-Process | Where-Object { \$_.Path -eq '$winpath' }
			if (\$p) { \$p | Stop-Process -Force; \$p | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue; 'closed' }
		" | tr -d '\r' | grep -q closed && echo "已关闭正在运行的程序"
	fi
	cp "dist/$name" "$dest"
	echo "已复制到 $dest"
fi
