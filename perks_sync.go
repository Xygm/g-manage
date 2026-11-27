package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

type patrolHandle struct {
	cancel context.CancelFunc
	done   chan struct{}
}

// preemptPatrol 在用户主动打开该号浏览器前，先中止正在后台无头运行的权益巡检并等待锁释放。
func (a *App) preemptPatrol(acc Account) {
	key := filepath.Clean(a.profilePath(acc))
	v, ok := a.patrolJobs.Load(key)
	if !ok {
		return
	}
	h := v.(*patrolHandle)
	h.cancel()
	select {
	case <-h.done:
	case <-time.After(4 * time.Second):
	}
}

/* ───────── 解析器（全部基于真实 Google 线上包体与页面文本结构） ───────── */

var (
	reAccountEmailAria = regexp.MustCompile(`(?i)Google Account:[^(]*\(([^)\s]+@[^)\s]+)\)`)
	reSubStatusDate    = regexp.MustCompile(`(?i)\b(Renews|Expires|Cancels|Ends)\s+on\s+([A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4})`)
	reAPIMonthly       = regexp.MustCompile(`(?i)\$(\d+)\s+monthly\s+Gen\s+AI`)
	reAPIRemaining     = regexp.MustCompile(`(?i)Remaining\s+balance:\s*\$([0-9]+(?:\.[0-9]+)?)`)
)

func stripXSSI(raw string) string {
	s := strings.TrimSpace(raw)
	if strings.HasPrefix(s, ")]}'") {
		s = strings.TrimSpace(s[4:])
	}
	return s
}

// parseFlowBatchExecute 从 flow.google.com 的 batchexecute (rpcid = nzlxg) 响应提取精确积分与下次发放时间。
// 真实样本：[["wrb.fr","nzlxg","[10050,8,9,3,null,10050,[1797960385]]",null,null,null,"generic"]]
func parseFlowBatchExecute(raw string) (credits int, nextGrant string, ok bool) {
	s := stripXSSI(raw)
	if !strings.Contains(s, `"nzlxg"`) {
		return 0, "", false
	}
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "[") || !strings.Contains(line, `"nzlxg"`) {
			continue
		}
		var outer []json.RawMessage
		if json.Unmarshal([]byte(line), &outer) != nil {
			continue
		}
		for _, item := range outer {
			var tuple []json.RawMessage
			if json.Unmarshal(item, &tuple) != nil || len(tuple) < 3 {
				continue
			}
			var kind, rpcID, innerStr string
			if json.Unmarshal(tuple[0], &kind) != nil || json.Unmarshal(tuple[1], &rpcID) != nil || json.Unmarshal(tuple[2], &innerStr) != nil {
				continue
			}
			if kind != "wrb.fr" || rpcID != "nzlxg" {
				continue
			}
			var payload []json.RawMessage
			if json.Unmarshal([]byte(innerStr), &payload) != nil || len(payload) == 0 {
				continue
			}
			var c float64
			if json.Unmarshal(payload[0], &c) != nil || c < 0 {
				continue
			}
			credits = int(math.Round(c))
			if len(payload) > 6 {
				var tsArr []int64
				if json.Unmarshal(payload[6], &tsArr) == nil && len(tsArr) > 0 && tsArr[0] > 1_700_000_000 {
					nextGrant = time.Unix(tsArr[0], 0).Local().Format("2006-01-02 15:04")
				}
			}
			return credits, nextGrant, true
		}
	}
	return 0, "", false
}

// parseColabCCUInfo 解析 https://colab.research.google.com/tun/m/ccu-info?authuser=0 返回体。
// 真实样本：)]}'\n[1000,0,0,["H100","G4","A100","L4","T4"],null,null,["V6E1","V5E1"]]
func parseColabCCUInfo(raw string) (cu float64, gpus []string, ok bool) {
	s := stripXSSI(raw)
	var arr []json.RawMessage
	if json.Unmarshal([]byte(s), &arr) != nil || len(arr) == 0 {
		return 0, nil, false
	}
	if json.Unmarshal(arr[0], &cu) != nil || cu < 0 || math.IsNaN(cu) || math.IsInf(cu, 0) {
		return 0, nil, false
	}
	cu = math.Round(cu*100) / 100
	if len(arr) > 3 {
		var list []string
		if json.Unmarshal(arr[3], &list) == nil {
			for _, g := range list {
				if g = strings.TrimSpace(g); g != "" && len(gpus) < 6 {
					gpus = append(gpus, g)
				}
			}
		}
	}
	return cu, gpus, true
}

// parseSubscriptionsText 从 myaccount.google.com/subscriptions?hl=en 页面文本解析续费态与日期。
func parseSubscriptionsText(text string) (state, ymd string, ok bool) {
	matches := reSubStatusDate.FindAllStringSubmatch(text, -1)
	for _, m := range matches {
		verb := strings.ToLower(m[1])
		parsed, err := time.Parse("Jan 2, 2006", m[2])
		if err != nil {
			parsed, err = time.Parse("January 2, 2006", m[2])
		}
		if err != nil {
			continue
		}
		ymd = parsed.Format(dateLayout)
		if verb == "renews" {
			state = "auto_renew"
		} else {
			state = "cancelled"
		}
		return state, ymd, true
	}
	return "", "", false
}

// parseOnePlansText 从 one.google.com/about/plans?hl=en 识别真实档位与订阅渠道。
// 套餐页会把 Pro、Ultra 全部列出来，只认离「Current plan」标记最近的那个套餐标题；
// Ultra 5x / 20x 由开发者权益页的月度赠金区分，这里不细分（页面上每个套餐的介绍都会出现）。
func parseOnePlansText(text, batchRaw string) (webTier, source string) {
	lines := strings.Split(strings.ToLower(text), "\n")
	best := -1
	for i, l := range lines {
		if !strings.Contains(l, "current plan") {
			continue
		}
		for j, t := range lines {
			var tier string
			switch strings.TrimSpace(t) {
			case "google ai ultra":
				tier = "ULTRA"
			case "google ai pro":
				tier = "PRO"
			default:
				continue
			}
			// 距离相同时取标记后面的标题（标记通常在卡片顶部）
			d := 2 * (j - i)
			if d < 0 {
				d = -d + 1
			}
			if best < 0 || d < best {
				best, webTier = d, tier
			}
		}
	}
	lower := strings.ToLower(text)
	batchLower := strings.ToLower(batchRaw)
	switch {
	case strings.Contains(lower, "apple settings") || strings.Contains(batchLower, "g1.ios."):
		source = "apple"
	case strings.Contains(lower, "google play"):
		source = "play_or_carrier"
	case webTier != "":
		source = "google"
	}
	return webTier, source
}

// parseDeveloperBenefitsText 解析 me.developers.google.com/benefits?hl=en 的月度赠金与档位信号。
func parseDeveloperBenefitsText(text string, now time.Time) (total int, balance *float64, claimedMonth, inferredTier string) {
	if m := reAPIMonthly.FindStringSubmatch(text); len(m) == 2 {
		total, _ = strconv.Atoi(m[1])
		switch total {
		case 10:
			inferredTier = "PRO"
		case 40:
			inferredTier = "ULTRA_5X"
		case 100:
			inferredTier = "ULTRA_20X"
		}
	}
	if m := reAPIRemaining.FindStringSubmatch(text); len(m) == 2 {
		if v, err := strconv.ParseFloat(m[1], 64); err == nil && v >= 0 {
			rounded := math.Round(v*100) / 100
			balance = &rounded
			claimedMonth = now.Format(monthLayout)
		}
	} else if total > 0 && (strings.Contains(strings.ToLower(text), "billing account") || strings.Contains(strings.ToLower(text), "always use this billing account")) {
		claimedMonth = now.Format(monthLayout)
	}
	return total, balance, claimedMonth, inferredTier
}

// parseFamilyDetailsText 解析 myaccount.google.com/family/details 页面角色与席位。
func parseFamilyDetailsText(text string) (role string, members, pending int, inferredTier string) {
	lower := strings.ToLower(text)
	if strings.Contains(lower, "google ai ultra plan") {
		inferredTier = "ULTRA"
	} else if strings.Contains(lower, "google ai pro plan") {
		inferredTier = "PRO"
	}
	if strings.Contains(lower, "you can create a family group") || strings.Contains(lower, "create a family group") {
		return "none", 0, 0, inferredTier
	}
	if !strings.Contains(lower, "family manager") && !strings.Contains(lower, "leave family group") {
		return "", 0, 0, inferredTier
	}
	lines := strings.Split(text, "\n")
	for _, l := range lines {
		s := strings.ToLower(strings.TrimSpace(l))
		switch {
		case strings.Contains(s, "invitation sent") || strings.HasPrefix(s, "invited"):
			pending++
		case s == "family manager" || s == "parent" || s == "member":
			members++
		}
	}
	if strings.Contains(lower, "delete family group") || strings.Contains(lower, "send invitations") || strings.Contains(lower, "invite family member") {
		role = "manager"
	} else {
		role = "member"
	}
	if members == 0 && role != "" {
		members = 1
	}
	if members > 6 {
		members = 6
	}
	if members+pending > 6 {
		pending = 6 - members
	}
	return role, members, pending, inferredTier
}

/* ───────── CDP 页面交互与提取执行器 ───────── */

type domSnapshot struct {
	URL   string `json:"url"`
	Email string `json:"email"`
	XSRF  string `json:"xsrf"`
	Tier  string `json:"tier"`
	Text  string `json:"text"`
}

const jsInspectPage = `(() => {
  const wiz = window.WIZ_global_data || {};
  let email = typeof wiz.oPEP7c === "string" ? wiz.oPEP7c : "";
  let tier = "";
  for (const el of document.querySelectorAll("[aria-label]")) {
    const a = el.getAttribute("aria-label") || "";
    if (!email && a.includes("@")) {
      const m = a.match(/\(([^)\s]+@[^)\s]+)\)/);
      if (m) email = m[1];
    }
    if (/^ULTRA\s+tier$/i.test(a)) tier = "ULTRA";
    else if (/^PRO\s+tier$/i.test(a) && !tier) tier = "PRO";
  }
  if (!email) {
    for (const sc of document.querySelectorAll("script")) {
      const t = sc.textContent || "";
      if (t.includes("this.gbar_")) {
        const m = t.match(/"([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})"/);
        if (m) { email = m[1]; break; }
      }
    }
  }
  return JSON.stringify({
    url: location.href,
    email: email.toLowerCase(),
    xsrf: typeof wiz.SNlM0e === "string" ? wiz.SNlM0e : "",
    tier,
    text: (document.body ? document.body.innerText : "").slice(0, 16000),
  });
})()`

func evalString(ctx context.Context, cli *cdpClient, sessionID, expr string, awaitPromise bool) (string, error) {
	var resp struct {
		Result struct {
			Type  string `json:"type"`
			Value any    `json:"value"`
		} `json:"result"`
		ExceptionDetails *struct {
			Text string `json:"text"`
		} `json:"exceptionDetails"`
	}
	err := cli.call(ctx, sessionID, "Runtime.evaluate", map[string]any{
		"expression":    expr,
		"returnByValue": true,
		"awaitPromise":  awaitPromise,
	}, &resp)
	if err != nil {
		return "", err
	}
	if resp.ExceptionDetails != nil {
		return "", errors.New(resp.ExceptionDetails.Text)
	}
	s, _ := resp.Result.Value.(string)
	return s, nil
}

func inspectDOM(ctx context.Context, cli *cdpClient, sessionID string) (domSnapshot, error) {
	raw, err := evalString(ctx, cli, sessionID, jsInspectPage, false)
	if err != nil {
		return domSnapshot{}, err
	}
	var snap domSnapshot
	err = json.Unmarshal([]byte(raw), &snap)
	return snap, err
}

func isSignInURL(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	h := strings.ToLower(u.Hostname())
	return h == "accounts.google.com"
}

// applyCleanUA 在无头实例导航前把 HeadlessChrome 清洗为同版本正常 Chrome UA，避免触发 Google 二次验证或掉登录。
func applyCleanUA(ctx context.Context, cli *cdpClient, sessionID string) {
	var ver struct {
		UserAgent string `json:"userAgent"`
	}
	if cli.call(ctx, "", "Browser.getVersion", nil, &ver) != nil || ver.UserAgent == "" {
		return
	}
	cleanUA := strings.ReplaceAll(ver.UserAgent, "HeadlessChrome/", "Chrome/")
	fullVer := "158.0.0.0"
	major := "158"
	if idx := strings.Index(cleanUA, "Chrome/"); idx >= 0 {
		rest := cleanUA[idx+len("Chrome/"):]
		if sp := strings.IndexByte(rest, ' '); sp > 0 {
			rest = rest[:sp]
		}
		if rest != "" {
			fullVer = rest
			if dot := strings.IndexByte(rest, '.'); dot > 0 {
				major = rest[:dot]
			}
		}
	}
	plat := "Windows"
	platVer := "15.0.0"
	arch := "x86"
	if runtime.GOOS == "darwin" {
		plat = "macOS"
		arch = "arm"
	}
	_ = cli.call(ctx, sessionID, "Emulation.setUserAgentOverride", map[string]any{
		"userAgent":      cleanUA,
		"acceptLanguage": "en-US,en;q=0.9,zh-CN;q=0.8",
		"platform":       plat,
		"userAgentMetadata": map[string]any{
			"brands": []map[string]string{
				{"brand": "Not.A/Brand", "version": "99"},
				{"brand": "Google Chrome", "version": major},
				{"brand": "Chromium", "version": major},
			},
			"fullVersion":     fullVer,
			"platform":        plat,
			"platformVersion": platVer,
			"architecture":    arch,
			"model":           "",
			"mobile":          false,
		},
	}, nil)
}

// navigateAndSettle 导航到指定 URL 并等待 load + 短暂异步渲染，同时收集命中的网络响应体。
func navigateAndSettle(ctx context.Context, cli *cdpClient, sessionID, targetURL string, settle time.Duration, matchURL func(string) bool) []string {
	var (
		mu      sync.Mutex
		reqIDs  []string
		loaded  = make(chan struct{}, 1)
	)
	unsub := cli.subscribe(func(ev cdpEvent) {
		if ev.SessionID != sessionID {
			return
		}
		switch ev.Method {
		case "Page.loadEventFired":
			select {
			case loaded <- struct{}{}:
			default:
			}
		case "Network.responseReceived":
			if matchURL == nil {
				return
			}
			var p struct {
				RequestID string `json:"requestId"`
				Response  struct {
					URL    string `json:"url"`
					Status int    `json:"status"`
				} `json:"response"`
			}
			if json.Unmarshal(ev.Params, &p) == nil && p.Response.Status == 200 && matchURL(p.Response.URL) {
				mu.Lock()
				reqIDs = append(reqIDs, p.RequestID)
				mu.Unlock()
			}
		}
	})
	defer unsub()

	stepCtx, cancel := context.WithTimeout(ctx, 16*time.Second)
	defer cancel()
	_ = cli.call(stepCtx, sessionID, "Page.navigate", map[string]any{"url": targetURL}, nil)

	select {
	case <-loaded:
	case <-stepCtx.Done():
	}

	timer := time.NewTimer(settle)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
	}

	mu.Lock()
	ids := append([]string(nil), reqIDs...)
	mu.Unlock()

	bodies := make([]string, 0, len(ids))
	for _, rid := range ids {
		var rb struct {
			Body          string `json:"body"`
			Base64Encoded bool   `json:"base64Encoded"`
		}
		bctx, bcancel := context.WithTimeout(ctx, 2*time.Second)
		err := cli.call(bctx, sessionID, "Network.getResponseBody", map[string]string{"requestId": rid}, &rb)
		bcancel()
		if err != nil || rb.Body == "" {
			continue
		}
		text := rb.Body
		if rb.Base64Encoded {
			if dec, err := base64.StdEncoding.DecodeString(rb.Body); err == nil {
				text = string(dec)
			}
		}
		bodies = append(bodies, text)
	}
	return bodies
}

// fetchFlowViaSameOriginRPC 在错过首屏网络包（如模式 A 顺手监听）时，直接在 flow.google.com 同源发起轻量 nzlxg 查询。
func fetchFlowViaSameOriginRPC(ctx context.Context, cli *cdpClient, sessionID string) (int, string, bool) {
	js := `(async () => {
		const at = window.WIZ_global_data?.SNlM0e || "";
		const body = "f.req=" + encodeURIComponent(JSON.stringify([[["nzlxg","[]",null,"generic"]]])) + (at ? "&at=" + encodeURIComponent(at) : "");
		const r = await fetch("/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=nzlxg&source-path=%2F", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
			body,
		});
		return r.ok ? await r.text() : "";
	})()`
	raw, err := evalString(ctx, cli, sessionID, js, true)
	if err != nil || raw == "" {
		return 0, "", false
	}
	return parseFlowBatchExecute(raw)
}

func fetchColabViaSameOrigin(ctx context.Context, cli *cdpClient, sessionID string) (float64, []string, bool) {
	js := `(async () => {
		const r = await fetch("/tun/m/ccu-info?authuser=0", { headers: { "X-Goog-Colab-Token": "1" } });
		return r.ok ? await r.text() : "";
	})()`
	raw, err := evalString(ctx, cli, sessionID, js, true)
	if err != nil || raw == "" {
		return 0, nil, false
	}
	return parseColabCCUInfo(raw)
}

func verifyPageAccount(accEmail, pageEmail string) (mismatch bool) {
	if pageEmail == "" {
		return false
	}
	return !sameGoogleAccount(accEmail, pageEmail)
}

func rankWebTier(t string) int {
	switch t {
	case "ULTRA_20X":
		return 4
	case "ULTRA_5X":
		return 3
	case "ULTRA":
		return 2
	case "PRO":
		return 1
	}
	return 0
}

// mergeWebTier 合并同一次同步里各页面的档位信号，取最高的。
func mergeWebTier(cur, candidate string) string {
	if rankWebTier(candidate) > rankWebTier(cur) {
		return candidate
	}
	return cur
}

// observeWebTier 用这次看到的档位更新存下的档位：降级、退订也要跟着变，不能只升不降；
// 只有笼统的 ULTRA 不覆盖之前已细分出的 Ultra 5x / 20x。
func observeWebTier(stored, seen string) string {
	if seen == "" || (seen == "ULTRA" && strings.HasPrefix(stored, "ULTRA_")) {
		return stored
	}
	return seen
}

// collectAllPerksOnSession 在单个后台标签页内串行访问目标页采集全部 5 项权益。
func collectAllPerksOnSession(ctx context.Context, cli *cdpClient, sessionID string, acc Account) (func(*AccountPerks) (bool, error), error) {
	_ = cli.call(ctx, sessionID, "Page.enable", nil, nil)
	_ = cli.call(ctx, sessionID, "Network.enable", map[string]any{"maxPostDataSize": 4096}, nil)
	applyCleanUA(ctx, cli, sessionID)

	var (
		gotAny       bool
		needsLogin   bool
		mismatch     bool
		billingAuth  string
		webTier      string
		flowCredits  *int
		flowGrantAt  string
		colabCU      *float64
		colabGPUs    []string
		apiTotal     int
		apiBalance   *float64
		apiMonth     string
		billState    string
		billDate     string
		billSource   string
		famRole      string
		famMembers   int
		famPending   int
	)

	now := time.Now()

	// 1. Flow 积分与下次发放时间（https://flow.google.com/）
	flowBodies := navigateAndSettle(ctx, cli, sessionID, "https://flow.google.com/", 3200*time.Millisecond, func(u string) bool {
		return strings.Contains(u, "batchexecute") && strings.Contains(u, "nzlxg")
	})
	if snap, err := inspectDOM(ctx, cli, sessionID); err == nil {
		if isSignInURL(snap.URL) || strings.Contains(strings.ToLower(snap.Text), "sign in with google") {
			needsLogin = true
		} else if verifyPageAccount(acc.Email, snap.Email) {
			mismatch = true
		} else {
			webTier = mergeWebTier(webTier, snap.Tier)
			for _, b := range flowBodies {
				if c, next, ok := parseFlowBatchExecute(b); ok {
					flowCredits = &c
					flowGrantAt = next
					gotAny = true
					break
				}
			}
			if flowCredits == nil {
				if c, next, ok := fetchFlowViaSameOriginRPC(ctx, cli, sessionID); ok {
					flowCredits = &c
					flowGrantAt = next
					gotAny = true
				}
			}
		}
	}
	if mismatch {
		return func(p *AccountPerks) (bool, error) {
			p.WebStatus = "account_mismatch"
			p.WebError = "独立浏览器当前登录的账号与该条目邮箱不一致"
			return false, nil
		}, nil
	}

	// 2. Colab 计算单元（https://colab.research.google.com/signup?hl=en）
	_ = navigateAndSettle(ctx, cli, sessionID, "https://colab.research.google.com/signup?hl=en", 1200*time.Millisecond, nil)
	if snap, err := inspectDOM(ctx, cli, sessionID); err == nil && !isSignInURL(snap.URL) {
		if verifyPageAccount(acc.Email, snap.Email) {
			mismatch = true
		} else if cu, gpus, ok := fetchColabViaSameOrigin(ctx, cli, sessionID); ok {
			colabCU = &cu
			colabGPUs = gpus
			gotAny = true
		}
	}

	// 3. Developer Program 月度美金赠金与 Ultra 5x/20x 档位校准（https://me.developers.google.com/benefits?hl=en）
	_ = navigateAndSettle(ctx, cli, sessionID, "https://me.developers.google.com/benefits?hl=en", 2500*time.Millisecond, nil)
	if snap, err := inspectDOM(ctx, cli, sessionID); err == nil && !isSignInURL(snap.URL) && !verifyPageAccount(acc.Email, snap.Email) {
		tot, bal, month, tier := parseDeveloperBenefitsText(snap.Text, now)
		if tot > 0 {
			apiTotal = tot
			gotAny = true
		}
		if bal != nil {
			apiBalance = bal
		}
		if month != "" {
			apiMonth = month
		}
		webTier = mergeWebTier(webTier, tier)
	}

	// 4. Google 订阅续费日 + Google One 渠道补充
	_ = navigateAndSettle(ctx, cli, sessionID, "https://myaccount.google.com/subscriptions?hl=en", 2000*time.Millisecond, nil)
	if snap, err := inspectDOM(ctx, cli, sessionID); err == nil {
		if isSignInURL(snap.URL) {
			if strings.Contains(snap.URL, "challenge") || strings.Contains(snap.URL, "reauth") {
				billingAuth = "needs_reauth"
			} else {
				needsLogin = true
			}
		} else if !verifyPageAccount(acc.Email, snap.Email) {
			if st, ymd, ok := parseSubscriptionsText(snap.Text); ok {
				billState, billDate = st, ymd
				gotAny = true
			}
		}
	}

	oneBodies := navigateAndSettle(ctx, cli, sessionID, "https://one.google.com/about/plans?hl=en", 2000*time.Millisecond, func(u string) bool {
		return strings.Contains(u, "batchexecute") && strings.Contains(u, "fS7U4c")
	})
	if snap, err := inspectDOM(ctx, cli, sessionID); err == nil && !isSignInURL(snap.URL) && !verifyPageAccount(acc.Email, snap.Email) {
		t, src := parseOnePlansText(snap.Text, strings.Join(oneBodies, "\n"))
		webTier = mergeWebTier(webTier, t)
		if src != "" {
			billSource = src
		}
		if t != "" {
			gotAny = true
		}
	}

	// 5. 家庭组席位（https://myaccount.google.com/family/details?hl=en）
	_ = navigateAndSettle(ctx, cli, sessionID, "https://myaccount.google.com/family/details?hl=en", 1800*time.Millisecond, nil)
	if snap, err := inspectDOM(ctx, cli, sessionID); err == nil && !isSignInURL(snap.URL) && !verifyPageAccount(acc.Email, snap.Email) {
		role, mem, pend, tier := parseFamilyDetailsText(snap.Text)
		webTier = mergeWebTier(webTier, tier)
		if role != "" {
			famRole, famMembers, famPending = role, mem, pend
			gotAny = true
		}
	}

	return func(p *AccountPerks) (bool, error) {
		if mismatch {
			p.WebStatus = "account_mismatch"
			p.WebError = "独立浏览器当前登录的账号与该条目邮箱不一致"
			return false, nil
		}
		if !gotAny && needsLogin {
			p.WebStatus = "needs_login"
			p.WebError = "该号独立浏览器尚未登录 Google，请先点「浏览器」完成登录"
			return false, nil
		}
		p.WebTier = observeWebTier(p.WebTier, webTier)
		if flowCredits != nil {
			p.FlowCredits = flowCredits
		}
		if flowGrantAt != "" {
			p.FlowNextGrantAt = flowGrantAt
		}
		if colabCU != nil {
			p.ColabCU = colabCU
			p.ColabGPUs = colabGPUs
			if *colabCU > 0 && p.ColabObservedAt == "" {
				p.ColabObservedAt = now.Format(dateLayout)
			} else if *colabCU == 0 {
				p.ColabObservedAt = ""
			}
		}
		if apiTotal > 0 {
			p.APICreditTotal = apiTotal
		}
		if apiBalance != nil {
			p.APICreditBalance = apiBalance
		}
		if apiMonth != "" {
			p.APICreditClaimedMonth = apiMonth
		}
		if billSource != "" {
			p.BillingSource = billSource
		}
		// 尊重用户手动锁定的非空防反撸状态；但若某字段仍为空（如只点了「自动续费」没填日期），允许自动补齐空缺。
		if billState != "" && (!p.BillingManual || p.BillingState == "") {
			p.BillingState = billState
		}
		if billDate != "" && (!p.BillingManual || p.RenewalDate == "") {
			p.RenewalDate = billDate
		}
		if famRole != "" {
			p.FamilyRole = famRole
			p.FamilyMembers = famMembers
			p.FamilyPending = famPending
		}
		p.BillingAuth = billingAuth
		p.WebStatus = "ok"
		p.WebError = ""
		return gotAny, nil
	}, nil
}

// syncAccountPerks 执行单个账号的自动权益同步：浏览器关着时拉起无头实例抓完优雅落盘退出。
// 手动打开的浏览器不挂调试通道（Google 登录页会因此拒绝登录），所以开着窗口时不同步。
func (a *App) syncAccountPerks(parentCtx context.Context, acc Account, st Settings) (Account, error) {
	if acc.ChromeProfile != "" {
		return acc, errors.New("该账号仍关联日常 Chrome 资料，请先在下方资料卡点「改为自带」后再自动同步")
	}
	chrome, err := findChrome(st.ChromePath)
	if err != nil {
		return acc, err
	}
	dir := filepath.Clean(a.profilePath(acc))
	if chromeRunning(dir) {
		return acc, errors.New("这个号的浏览器正开着，请先关掉该浏览器窗口再同步")
	}

	// 浏览器未开，启动受控无头实例，支持被用户点击「打开浏览器」随时抢占让路。
	ctx, cancel := context.WithTimeout(parentCtx, 55*time.Second)
	handle := &patrolHandle{cancel: cancel, done: make(chan struct{})}
	if _, loaded := a.patrolJobs.LoadOrStore(dir, handle); loaded {
		cancel()
		return acc, errors.New("这个号的会员权益正在同步中")
	}
	defer func() {
		cancel()
		a.patrolJobs.Delete(dir)
		close(handle.done)
	}()

	unlock := a.lockBrowser(acc)
	if chromeRunning(dir) {
		unlock()
		return acc, errors.New("这个号的浏览器刚被打开，请稍后再试")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		unlock()
		return acc, err
	}
	_ = os.Remove(filepath.Join(dir, "DevToolsActivePort"))

	args := []string{
		"--headless=new",
		"--user-data-dir=" + dir,
		"--remote-debugging-port=0",
		"--window-size=1280,800",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-session-crashed-bubble",
		"--hide-crash-restore-bubble",
	}
	if p := proxyFor(acc, st); p != "" {
		args = append(args, "--proxy-server="+p)
	}
	args = append(args, "about:blank")

	cmd := exec.Command(chrome, args...)
	if err := cmd.Start(); err != nil {
		unlock()
		return acc, fmt.Errorf("启动后台 Chrome 失败：%w", err)
	}
	unlock() // 启动后立即释放目录锁，绝不在耗时网络采集期间阻塞其它操作

	var cli *cdpClient
	defer func() {
		if cli != nil {
			closeCtx, closeCancel := context.WithTimeout(context.Background(), 2*time.Second)
			_ = cli.call(closeCtx, "", "Browser.close", nil, nil)
			closeCancel()
			_ = cli.Close()
		}
		exited := make(chan struct{})
		go func() {
			_ = cmd.Wait()
			close(exited)
		}()
		select {
		case <-exited:
		case <-time.After(3 * time.Second):
			_ = cmd.Process.Kill()
			<-exited
		}
		for deadline := time.Now().Add(2 * time.Second); chromeRunning(dir) && time.Now().Before(deadline); {
			time.Sleep(120 * time.Millisecond)
		}
	}()

	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
		if ctx.Err() != nil {
			return acc, errors.New("已为打开浏览器让路，同步已取消")
		}
		dctx, dcancel := context.WithTimeout(ctx, 1200*time.Millisecond)
		c, derr := dialCDPFromDir(dctx, dir)
		dcancel()
		if derr == nil {
			cli = c
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if cli == nil {
		return acc, errors.New("等待浏览器调试通道就绪超时")
	}

	var targets struct {
		TargetInfos []struct {
			TargetID string `json:"targetId"`
			Type     string `json:"type"`
		} `json:"targetInfos"`
	}
	if err := cli.call(ctx, "", "Target.getTargets", nil, &targets); err != nil {
		return acc, err
	}
	var pageTargetID string
	for _, ti := range targets.TargetInfos {
		if ti.Type == "page" {
			pageTargetID = ti.TargetID
			break
		}
	}
	if pageTargetID == "" {
		var created struct {
			TargetID string `json:"targetId"`
		}
		if err := cli.call(ctx, "", "Target.createTarget", map[string]any{"url": "about:blank"}, &created); err != nil {
			return acc, err
		}
		pageTargetID = created.TargetID
	}

	var attached struct {
		SessionID string `json:"sessionId"`
	}
	if err := cli.call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": pageTargetID, "flatten": true}, &attached); err != nil {
		return acc, err
	}

	mergeFn, err := collectAllPerksOnSession(ctx, cli, attached.SessionID, acc)
	if err != nil {
		if ctx.Err() != nil {
			return acc, errors.New("同步已取消或超时")
		}
		return acc, err
	}
	return a.store.UpdatePerks(acc.ID, mergeFn)
}

/* ───────── HTTP 接口 ───────── */

func (a *App) refreshOneAccountPerks(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	acc, err := a.store.GetAccount(id)
	if err != nil {
		writeErr(w, err)
		return
	}
	st, err := a.store.GetSettings()
	if err != nil {
		writeErr(w, err)
		return
	}
	saved, err := a.syncAccountPerks(r.Context(), acc, st)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, a.view(saved, today()))
}

func isPerksCandidate(acc Account) bool {
	if acc.ChromeProfile != "" {
		return false
	}
	if acc.PerksJSON != "" {
		var p AccountPerks
		if json.Unmarshal([]byte(acc.PerksJSON), &p) == nil {
			t := strings.ToUpper(p.TierOverride)
			if t == "" {
				t = strings.ToUpper(p.WebTier)
			}
			if t == "PRO" || strings.HasPrefix(t, "ULTRA") || p.BillingState == "auto_renew" || p.FlowCredits != nil || p.ColabCU != nil {
				return true
			}
		}
	}
	if acc.QuotaJSON != "" {
		var q QuotaInfo
		if json.Unmarshal([]byte(acc.QuotaJSON), &q) == nil {
			t := strings.ToUpper(q.Tier)
			if t == "PRO" || strings.HasPrefix(t, "ULTRA") {
				return true
			}
		}
	}
	return false
}

// refreshAllPerks 低并发（上限 2）排队同步所有独立浏览器会员号的附赠权益；支持 ?ids=1,2 指定账号。
func (a *App) refreshAllPerks(w http.ResponseWriter, r *http.Request) {
	accs, err := a.store.ListAccounts()
	if err != nil {
		writeErr(w, err)
		return
	}
	st, err := a.store.GetSettings()
	if err != nil {
		writeErr(w, err)
		return
	}
	var only map[int64]bool
	if raw := r.URL.Query().Get("ids"); raw != "" {
		only = map[int64]bool{}
		for _, s := range strings.Split(raw, ",") {
			if id, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64); err == nil {
				only[id] = true
			}
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()

	sem := make(chan struct{}, 2) // 最多同时运行 2 个后台 Chrome，防止撑爆内存与代理
	var wg sync.WaitGroup
	for _, acc := range accs {
		if only != nil {
			if !only[acc.ID] {
				continue
			}
		} else if !isPerksCandidate(acc) {
			continue
		}
		wg.Add(1)
		go func(acc Account) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()
			if _, err := a.syncAccountPerks(ctx, acc, st); err != nil {
				log.Printf("同步 %s 的会员权益失败：%v", acc.Email, err)
			}
		}(acc)
	}
	wg.Wait()
	a.writeViews(w)
}
