package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

var (
	// 禁止在组件中使用原生 Tailwind 调色板类名（必须走 styles.css 语义令牌，保障亮/暗双主题一致）。
	reTailwindPalette = regexp.MustCompile(`\b(?:bg|text|border|ring|outline|from|via|to|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)\b`)

	// 禁止在 TSX/TS 中硬编码 6/8 位 #hex 色值或任意色值类 [#xxx]。
	reRawHexColor      = regexp.MustCompile(`#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b`)
	reArbitraryHexUtil = regexp.MustCompile(`\[#[0-9a-fA-F]{3,8}\]`)

	// 动效与交互反模式：禁止 transition-all 与阻塞式原生弹窗。
	reTransitionAll = regexp.MustCompile(`\btransition-all\b`)
	reNativeDialog  = regexp.MustCompile(`(?:\b(?:window|globalThis)\.(?:alert|confirm|prompt)\s*\(|(?:^|[^\w.$])(?:alert|prompt)\s*\()`)

	// CSS 变量名提取。
	reCSSVarDecl = regexp.MustCompile(`^\s*(--[a-zA-Z0-9-]+)\s*:`)

	// HTML 静态资源引用提取。
	reHTMLAssetRef = regexp.MustCompile(`(?:src|href)="(\.?/[^"]+)"`)
)

func walkFrontendTS(t *testing.T, fn func(rel string, lines []string, full string)) {
	t.Helper()
	root := filepath.Join("frontend", "src")
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		ext := filepath.Ext(path)
		if ext != ".ts" && ext != ".tsx" {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			rel = path
		}
		rel = filepath.ToSlash(rel)
		content := string(raw)
		fn(rel, strings.Split(content, "\n"), content)
		return nil
	})
	if err != nil {
		t.Fatalf("扫描 frontend/src 失败: %v", err)
	}
}

func isExemptHexLine(rel, line string) bool {
	// 1. 首字母头像确定性哈希色板（唯一允许定义种子色相数组的位置）。
	if rel == "ui/display.tsx" && strings.Contains(line, "const avatarHues =") {
		return true
	}
	// 2. 标签自定义颜色选择器的彩虹色轮示意图标。
	if rel == "main/Inspector.tsx" && strings.Contains(line, "conic-gradient(") {
		return true
	}
	return false
}

// TestDesignTokenPurity 守护设计令牌纯洁度，防止硬编码颜色破坏视觉系统与暗色模式。
func TestDesignTokenPurity(t *testing.T) {
	walkFrontendTS(t, func(rel string, lines []string, _ string) {
		for idx, line := range lines {
			lineNo := idx + 1
			if m := reTailwindPalette.FindString(line); m != "" {
				t.Errorf("frontend/src/%s:%d 发现硬编码 Tailwind 调色板类名 %q；请改用 styles.css 中的语义令牌（如 bg-surface / text-ink-2 / bg-danger-soft，详见 docs/DESIGN.md）", rel, lineNo, m)
			}
			if isExemptHexLine(rel, line) {
				continue
			}
			if m := reArbitraryHexUtil.FindString(line); m != "" {
				t.Errorf("frontend/src/%s:%d 发现硬编码任意色值类 %q；请改用语义令牌或 CSS 变量（详见 docs/DESIGN.md）", rel, lineNo, m)
			} else if m := reRawHexColor.FindString(line); m != "" {
				t.Errorf("frontend/src/%s:%d 发现裸十六进制色值 %q；请在 frontend/src/styles.css 中定义亮/暗双主题语义令牌后引用", rel, lineNo, m)
			}
		}
	})
}

// TestDarkThemeTokenParity 确保手动暗色模式与系统跟随暗色模式的 CSS 变量集合严格一致，且均在 :root 中有基准定义。
func TestDarkThemeTokenParity(t *testing.T) {
	cssPath := filepath.Join("frontend", "src", "styles.css")
	raw, err := os.ReadFile(cssPath)
	if err != nil {
		t.Fatalf("读取 %s 失败: %v", cssPath, err)
	}
	css := string(raw)

	extractVars := func(block string) map[string]bool {
		out := make(map[string]bool)
		for _, line := range strings.Split(block, "\n") {
			if m := reCSSVarDecl.FindStringSubmatch(line); len(m) == 2 {
				out[m[1]] = true
			}
		}
		return out
	}

	extractSection := func(startMarker string) string {
		idx := strings.Index(css, startMarker)
		if idx < 0 {
			t.Fatalf("%s 缺少必需的主题块 %q", cssPath, startMarker)
		}
		rest := css[idx+len(startMarker):]
		depth := 0
		started := false
		for i, ch := range rest {
			if ch == '{' {
				depth++
				started = true
			} else if ch == '}' {
				depth--
				if started && depth == 0 {
					return rest[:i]
				}
			}
		}
		t.Fatalf("%s 主题块 %q 大括号未闭合", cssPath, startMarker)
		return ""
	}

	lightVars := extractVars(extractSection(":root {"))
	manualDarkVars := extractVars(extractSection(`:root[data-theme="dark"]`))
	autoDarkVars := extractVars(extractSection("@media (prefers-color-scheme: dark)"))

	if len(manualDarkVars) == 0 {
		t.Fatalf("%s 的暗色主题未解析出任何 CSS 变量", cssPath)
	}

	for v := range manualDarkVars {
		if !lightVars[v] {
			t.Errorf("%s 中暗色变量 %s 未在基础 :root 亮色块中定义", cssPath, v)
		}
		if !autoDarkVars[v] {
			t.Errorf(`%s 中变量 %s 在 :root[data-theme="dark"] 中定义，但漏掉了 @media (prefers-color-scheme: dark) 同步`, cssPath, v)
		}
	}
	for v := range autoDarkVars {
		if !manualDarkVars[v] {
			t.Errorf(`%s 中变量 %s 在 @media (prefers-color-scheme: dark) 中定义，但漏掉了 :root[data-theme="dark"] 同步`, cssPath, v)
		}
	}
}

// TestMotionAndUXGuardrails 守护动效流畅度、无阻塞交互与主列表固定行高虚拟化结构。
func TestMotionAndUXGuardrails(t *testing.T) {
	foundRowH := false
	walkFrontendTS(t, func(rel string, lines []string, full string) {
		if rel == "main/AccountList.tsx" && strings.Contains(full, "const ROW_H =") {
			foundRowH = true
		}
		for idx, line := range lines {
			lineNo := idx + 1
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "*") {
				continue
			}
			if reTransitionAll.MatchString(line) {
				t.Errorf("frontend/src/%s:%d 禁止使用 transition-all（易引发布局重排掉帧）；请显式指定过渡属性或使用 src/lib/motion.ts 弹簧参数", rel, lineNo)
			}
			if m := reNativeDialog.FindString(line); m != "" {
				t.Errorf("frontend/src/%s:%d 禁止使用阻塞式原生弹窗 (%s)；请改用 ConfirmPop 或带 undo 的 toast（详见 docs/DESIGN.md）", rel, lineNo, strings.TrimSpace(m))
			}
		}
	})
	if !foundRowH {
		t.Errorf("frontend/src/main/AccountList.tsx 缺少固定行高常量 ROW_H，不得破坏百号级 60fps 虚拟滚动架构")
	}
}

// TestEmbeddedWebAssetsIntegrity 验证 web/ 内嵌构建产物完整存在且无孤儿陈旧 bundle。
func TestEmbeddedWebAssetsIntegrity(t *testing.T) {
	entries := []string{"index.html", "mini.html"}
	corpus := strings.Builder{}

	for _, name := range entries {
		p := filepath.Join("web", name)
		raw, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("缺少内嵌前端入口 %s（请运行 npm --prefix frontend run build）: %v", p, err)
		}
		html := string(raw)
		corpus.WriteString(html)
		corpus.WriteByte('\n')

		matches := reHTMLAssetRef.FindAllStringSubmatch(html, -1)
		if len(matches) == 0 {
			t.Errorf("%s 未解析到任何静态资源引用", p)
		}
		for _, m := range matches {
			ref := strings.TrimPrefix(m[1], "./")
			ref = strings.TrimPrefix(ref, "/")
			target := filepath.Join("web", filepath.FromSlash(ref))
			info, err := os.Stat(target)
			if err != nil || info.IsDir() || info.Size() == 0 {
				t.Errorf("%s 引用的资源 %q 不存在或为空（请重新运行 npm --prefix frontend run build 并提交 web/）", p, target)
			}
		}
	}

	assetsDir := filepath.Join("web", "assets")
	dirEntries, err := os.ReadDir(assetsDir)
	if err != nil {
		t.Fatalf("读取 %s 失败: %v", assetsDir, err)
	}
	var assetNames []string
	for _, e := range dirEntries {
		if e.IsDir() {
			continue
		}
		assetNames = append(assetNames, e.Name())
		if strings.HasSuffix(e.Name(), ".js") || strings.HasSuffix(e.Name(), ".css") {
			if raw, err := os.ReadFile(filepath.Join(assetsDir, e.Name())); err == nil {
				corpus.Write(raw)
				corpus.WriteByte('\n')
			}
		}
	}
	sort.Strings(assetNames)
	allRefs := corpus.String()
	for _, name := range assetNames {
		if !strings.Contains(allRefs, name) {
			t.Errorf("web/assets/%s 未被任何入口或 chunk 引用，属于陈旧残留文件，请重新构建清理后再提交", name)
		}
	}
}

// TestGuardrailRegexesCatchViolations 自检守护规则本身能准确命中违规写法且不误伤合法代码。
func TestGuardrailRegexesCatchViolations(t *testing.T) {
	badPalette := []string{"bg-blue-500", "text-gray-400", "border-zinc-200", "ring-red-500/20", "from-violet-600"}
	for _, s := range badPalette {
		if !reTailwindPalette.MatchString(s) {
			t.Errorf("reTailwindPalette 未能拦截违规类名 %q", s)
		}
	}
	goodTokens := []string{"bg-surface", "bg-surface-2", "text-ink-2", "bg-danger-soft", "text-violet", "shadow-raised"}
	for _, s := range goodTokens {
		if reTailwindPalette.MatchString(s) {
			t.Errorf("reTailwindPalette 误伤合法语义令牌 %q", s)
		}
	}

	if !reRawHexColor.MatchString(`style={{ color: "#3b82f6" }}`) {
		t.Errorf("reRawHexColor 未能拦截 6 位裸色值")
	}
	if reRawHexColor.MatchString(`s.includes("#3501")`) {
		t.Errorf("reRawHexColor 误伤错误码字符串 #3501")
	}
	if !reArbitraryHexUtil.MatchString(`className="bg-[#fff] text-[#123456]"`) {
		t.Errorf("reArbitraryHexUtil 未能拦截任意色值工具类")
	}
	if !reTransitionAll.MatchString(`className="rounded-lg transition-all duration-200"`) {
		t.Errorf("reTransitionAll 未能拦截 transition-all")
	}
	if reTransitionAll.MatchString(`className="transition-colors duration-[120ms]"`) {
		t.Errorf("reTransitionAll 误伤 transition-colors")
	}
	if !reNativeDialog.MatchString(`if (window.confirm("确定删除？"))`) || !reNativeDialog.MatchString(`alert("失败")`) {
		t.Errorf("reNativeDialog 未能拦截原生阻塞弹窗")
	}
	if reNativeDialog.MatchString(`const [confirm, setConfirm] = useState(false);`) {
		t.Errorf("reNativeDialog 误伤合法状态变量 confirm")
	}
}

