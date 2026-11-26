#!/usr/bin/env bash
# 在 macOS 上构建桌面版：生成 dist/谷歌账号管理.app（本机架构，需要 Xcode 命令行工具，cgo 编译 Cocoa 外壳）。
# 可用环境变量 GO 指定 go 程序路径；SKIP_FRONTEND=1 跳过前端构建，直接打包现有的 web/。
set -euo pipefail
cd "$(dirname "$0")"
GO="${GO:-go}"
name="谷歌账号管理"
app="dist/$name.app"

if [ "${SKIP_FRONTEND:-}" = 1 ]; then
	echo "跳过前端构建，使用现有的 web/"
elif [ -d frontend/node_modules ]; then
	npm --prefix frontend run build
else
	echo "警告：没有 frontend/node_modules，跳过前端构建（先在 frontend 里 npm install），使用现有的 web/" >&2
fi

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
CGO_ENABLED=1 "$GO" build -trimpath -ldflags "-s -w" -o "$app/Contents/MacOS/gam" .

# 图标：Go 画 1024px 原图，sips 缩出各尺寸，iconutil 打包成 icns。
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
"$GO" run tools/mkicon/main.go "$tmp"
iconset="$tmp/AppIcon.iconset"
mkdir "$iconset"
for s in 16 32 128 256 512; do
	sips -z "$s" "$s" "$tmp/icon_1024.png" --out "$iconset/icon_${s}x${s}.png" >/dev/null
	d=$((s * 2))
	sips -z "$d" "$d" "$tmp/icon_1024.png" --out "$iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"

build=$(date +%Y%m%d%H%M)
cat >"$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>$name</string>
	<key>CFBundleDisplayName</key>
	<string>$name</string>
	<key>CFBundleIdentifier</key>
	<string>com.gam.google-account-manager</string>
	<key>CFBundleExecutable</key>
	<string>gam</string>
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0.0</string>
	<key>CFBundleVersion</key>
	<string>$build</string>
	<key>CFBundleDevelopmentRegion</key>
	<string>zh_CN</string>
	<key>LSMinimumSystemVersion</key>
	<string>13.0</string>
	<key>LSApplicationCategoryType</key>
	<string>public.app-category.productivity</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSPrincipalClass</key>
	<string>NSApplication</string>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsLocalNetworking</key>
		<true/>
	</dict>
</dict>
</plist>
EOF
plutil -lint "$app/Contents/Info.plist" >/dev/null

# 本地自用：整个包做一次临时签名（ad-hoc），否则改过的包在 Apple 芯片上可能打不开。
if command -v codesign >/dev/null; then
	codesign --force --deep --sign - "$app" >/dev/null 2>&1 || echo "警告：codesign 临时签名失败" >&2
fi
echo "已生成 $app"
