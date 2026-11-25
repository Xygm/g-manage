package main

// 直接对接 Google：用 Antigravity 官方 OAuth 客户端授权，再调用 Cloud Code 内部接口查反重力额度。
// 协议细节参照 lbjlaq/Antigravity-Manager（src-tauri/src/modules/oauth.rs、quota.rs）。
// 这些是 Google 未公开的内部接口，官方改动后可能需要跟着改下面的常量。

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type oauthClient struct{ id, secret string }

// 第一个是 Antigravity 个人版客户端（授权时使用）；第二个是企业 / GCP 版，
// 仅用于刷新从别处粘贴来的、由该客户端签发的 refresh token。
var oauthClients = []oauthClient{
	{"1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com", "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"},
	{"884354919052-36trc1jjb3tguiac32ov6cod268c5blh.apps.googleusercontent.com", "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"},
}

const (
	oauthAuthURL  = "https://accounts.google.com/o/oauth2/v2/auth"
	oauthTokenURL = "https://oauth2.googleapis.com/token"
	userInfoURL   = "https://www.googleapis.com/oauth2/v2/userinfo"

	oauthUserAgent = "vscode/1.X.X (Antigravity/4.3.0)"
	// Google 要求 UA 含 antigravity，且版本过旧会被拒。
	upstreamUserAgent = "antigravity/hub/2.33.0 (aidev_client; os_type=windows; arch=amd64; cl=1023160026)"
)

var oauthScopes = strings.Join([]string{
	"openid",
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
	"https://www.googleapis.com/auth/aicode",
}, " ")

var (
	codeAssistBaseURLs = []string{
		"https://daily-cloudcode-pa.googleapis.com",
		"https://daily-cloudcode-pa.sandbox.googleapis.com",
		"https://cloudcode-pa.googleapis.com",
	}
	// 额度只认 daily / sandbox：prod 端点返回的 Gemini 额度与它们不一致。
	quotaSummaryURLs = []string{
		"https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
		"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
	}
)

var ErrTokenRevoked = errors.New("授权已失效（refresh token 被撤销或过期），请重新授权")

type QuotaInfo struct {
	Tier   string       `json:"tier"` // FREE / PRO / ULTRA / ENTERPRISE，取不到为空
	Groups []QuotaGroup `json:"groups"`
}

type QuotaGroup struct {
	DisplayName string        `json:"display_name"`
	Buckets     []QuotaBucket `json:"buckets"`
}

type QuotaBucket struct {
	Window            string  `json:"window"` // "weekly" / "5h"
	DisplayName       string  `json:"display_name,omitempty"`
	RemainingFraction float64 `json:"remaining_fraction"` // 0.0-1.0
	ResetTime         string  `json:"reset_time"`
}

func randomState() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func authURL(redirectURI, state, loginHint string) string {
	q := url.Values{
		"client_id":              {oauthClients[0].id},
		"redirect_uri":           {redirectURI},
		"response_type":          {"code"},
		"scope":                  {oauthScopes},
		"access_type":            {"offline"},
		"prompt":                 {"consent"},
		"include_granted_scopes": {"true"},
		"state":                  {state},
		"login_hint":             {loginHint},
	}
	return oauthAuthURL + "?" + q.Encode()
}

// googleClient 的所有请求都走该账号的代理，避免多个号从同一 IP 访问 Google。
type googleClient struct{ http *http.Client }

func newGoogleClient(proxy string) (*googleClient, error) {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	if proxy != "" {
		u, err := parseProxy(proxy)
		if err != nil {
			return nil, err
		}
		tr.Proxy = http.ProxyURL(u)
	}
	return &googleClient{http: &http.Client{Timeout: 30 * time.Second, Transport: tr}}, nil
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`   // 授权范围含 openid 时，刷新也会返回
	ExpiresIn    int64  `json:"expires_in"` // 秒
}

type googleError struct {
	status int
	body   string
}

func (e *googleError) Error() string {
	return summarizeGoogleError(e.status, e.body)
}

func summarizeGoogleError(status int, body string) string {
	trimmed := strings.TrimSpace(body)
	var rpc struct {
		Error struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
			Status  string `json:"status"`
			Details []struct {
				Reason   string            `json:"reason"`
				Metadata map[string]string `json:"metadata"`
				Links    []struct {
					Description string `json:"description"`
					URL         string `json:"url"`
				} `json:"links"`
			} `json:"details"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(trimmed), &rpc) == nil && (rpc.Error.Message != "" || rpc.Error.Status != "") {
		var reason, actionURL string
		for _, d := range rpc.Error.Details {
			if reason == "" && d.Reason != "" {
				reason = d.Reason
			}
			for _, k := range []string{"validation_url", "validationUrl", "appeal_url"} {
				if actionURL == "" && strings.HasPrefix(d.Metadata[k], "https://") {
					actionURL = d.Metadata[k]
				}
			}
			// google.rpc.Help 里「Verify your account」那条就是验证入口。
			for _, l := range d.Links {
				if actionURL == "" && strings.HasPrefix(l.URL, "https://") && strings.Contains(strings.ToLower(l.Description), "verify") {
					actionURL = l.URL
				}
			}
		}
		msg := strings.TrimSpace(rpc.Error.Message)
		lowerMsg := strings.ToLower(msg)
		switch {
		case reason == "VALIDATION_REQUIRED" && actionURL != "":
			return "账号需要完成安全验证（VALIDATION_REQUIRED）：请在该账号浏览器中完成验证后刷新额度 " + actionURL
		case reason == "SUBSCRIPTION_REQUIRED" || strings.Contains(msg, "#3501"):
			return "未开通可用许可（#3501）：该账号未获得免费档资格且无有效订阅，请检查代理节点地区与 Google 账号归属国家"
		case reason == "ACCOUNT_DISABLED" || strings.Contains(lowerMsg, "violation of terms of service"):
			return "该 Google 账号的服务已被停用（违反服务条款），需在浏览器中提交申诉"
		case status == http.StatusUnauthorized || rpc.Error.Status == "UNAUTHENTICATED":
			return "登录凭证已失效（401），请点右侧「重新授权」"
		case status == http.StatusTooManyRequests || rpc.Error.Status == "RESOURCE_EXHAUSTED":
			return "Google 接口请求过于频繁（429），请稍后再试"
		case reason != "" && msg != "":
			return fmt.Sprintf("Google 返回 %d（%s）：%s", status, reason, msg)
		case msg != "":
			return fmt.Sprintf("Google 返回 %d：%s", status, msg)
		}
	}
	var oauthErr struct {
		Err  string `json:"error"`
		Desc string `json:"error_description"`
	}
	if json.Unmarshal([]byte(trimmed), &oauthErr) == nil && oauthErr.Err != "" {
		if oauthErr.Desc != "" {
			return fmt.Sprintf("Google 返回 %d（%s）：%s", status, oauthErr.Err, oauthErr.Desc)
		}
		return fmt.Sprintf("Google 返回 %d：%s", status, oauthErr.Err)
	}
	return fmt.Sprintf("Google 返回 %d：%s", status, trimmed)
}

func (g *googleClient) do(req *http.Request, out any) error {
	resp, err := g.http.Do(req)
	if err != nil {
		return fmt.Errorf("连不上 Google（检查代理）：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10)) // 403 的验证链接在报错详情末尾，读少了会被截断
		return &googleError{status: resp.StatusCode, body: strings.TrimSpace(string(body))}
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("解析 Google 返回失败：%w", err)
	}
	return nil
}

func (g *googleClient) postToken(ctx context.Context, form url.Values) (tokenResponse, error) {
	var tok tokenResponse
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, oauthTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return tok, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", oauthUserAgent)
	return tok, g.do(req, &tok)
}

func (g *googleClient) exchangeCode(ctx context.Context, code, redirectURI string) (tokenResponse, error) {
	c := oauthClients[0]
	return g.postToken(ctx, url.Values{
		"client_id":     {c.id},
		"client_secret": {c.secret},
		"code":          {code},
		"redirect_uri":  {redirectURI},
		"grant_type":    {"authorization_code"},
	})
}

func (g *googleClient) accessToken(ctx context.Context, refreshToken string) (string, error) {
	tok, _, err := g.refreshAccess(ctx, refreshToken)
	return tok.AccessToken, err
}

// refreshAccess 用 refresh token 换新的 access token，同时返回签发它的客户端（oauthClients 的下标）。
func (g *googleClient) refreshAccess(ctx context.Context, refreshToken string) (tokenResponse, int, error) {
	var lastErr error
	for i, c := range oauthClients {
		tok, err := g.postToken(ctx, url.Values{
			"client_id":     {c.id},
			"client_secret": {c.secret},
			"refresh_token": {refreshToken},
			"grant_type":    {"refresh_token"},
		})
		if err == nil {
			return tok, i, nil
		}
		lastErr = err
		var ge *googleError
		if !errors.As(err, &ge) {
			return tokenResponse{}, 0, err // 网络错误，换客户端也没用
		}
		// token 不属于这个客户端时换下一个；其余错误（如 invalid_grant）直接判定
		if strings.Contains(ge.body, "unauthorized_client") || strings.Contains(ge.body, "invalid_client") {
			continue
		}
		if strings.Contains(ge.body, "invalid_grant") {
			return tokenResponse{}, 0, ErrTokenRevoked
		}
		return tokenResponse{}, 0, err
	}
	return tokenResponse{}, 0, lastErr
}

func (g *googleClient) userEmail(ctx context.Context, accessToken string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, userInfoURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	var info struct {
		Email string `json:"email"`
	}
	if err := g.do(req, &info); err != nil {
		return "", err
	}
	return strings.ToLower(info.Email), nil
}

// sameGoogleAccount 判断两个邮箱是不是同一个 Google 账号：Gmail 地址里的点和 + 后缀不算数
// （t.homas@gmail.com 和 thomas@gmail.com 是同一个号，Google 返回的是不带点的写法）。
func sameGoogleAccount(a, b string) bool {
	return canonicalGmail(a) == canonicalGmail(b)
}

func canonicalGmail(email string) string {
	email = strings.ToLower(strings.TrimSpace(email))
	local, domain, ok := strings.Cut(email, "@")
	if !ok || (domain != "gmail.com" && domain != "googlemail.com") {
		return email
	}
	local, _, _ = strings.Cut(local, "+")
	return strings.ReplaceAll(local, ".", "") + "@gmail.com"
}

// postInternal 依次尝试多个等价端点，返回第一个成功的结果。
func (g *googleClient) postInternal(ctx context.Context, urls []string, accessToken string, payload, out any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	var lastErr error
	for _, u := range urls {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+accessToken)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", upstreamUserAgent)
		if lastErr = g.do(req, out); lastErr == nil {
			return nil
		}
	}
	return lastErr
}

type cloudTier struct {
	ID                 string `json:"id"`
	Name               string `json:"name"`
	IsDefault          bool   `json:"isDefault"`
	UserDefinedProject bool   `json:"userDefinedCloudaicompanionProject"`
}

func (t *cloudTier) label() string {
	if t == nil {
		return ""
	}
	if t.ID != "" {
		return t.ID
	}
	return t.Name
}

type ineligibleTier struct {
	ReasonCode      string `json:"reasonCode"`
	ReasonMessage   string `json:"reasonMessage"`
	TierID          string `json:"tierId"`
	TierName        string `json:"tierName"`
	ValidationURL   string `json:"validationUrl"`
	ValidationError string `json:"validationErrorMessage"`
}

type loadCodeAssistResp struct {
	Project         string           `json:"cloudaicompanionProject"`
	CurrentTier     *cloudTier       `json:"currentTier"`
	PaidTier        *cloudTier       `json:"paidTier"`
	AllowedTiers    []cloudTier      `json:"allowedTiers"`
	IneligibleTiers []ineligibleTier `json:"ineligibleTiers"`
}

type onboardProject string

func (p *onboardProject) UnmarshalJSON(data []byte) error {
	var s string
	if err := json.Unmarshal(data, &s); err == nil {
		*p = onboardProject(s)
		return nil
	}
	var obj struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(data, &obj); err == nil {
		*p = onboardProject(obj.ID)
		return nil
	}
	return nil
}

type onboardOperation struct {
	Name  string `json:"name"`
	Done  bool   `json:"done"`
	Error *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
	Response *struct {
		Project onboardProject `json:"cloudaicompanionProject"`
	} `json:"response"`
}

// normalizeTier 与 Antigravity-Manager 的 normalize_subscription_tier 规则一致。
func normalizeTier(raw string) string {
	s := strings.ToLower(raw)
	switch {
	case strings.Contains(s, "ultra") || strings.Contains(s, "helium"):
		return "ULTRA"
	case strings.Contains(s, "free") || strings.Contains(s, "starter"):
		return "FREE"
	case strings.Contains(s, "pro") || strings.Contains(s, "premium") || strings.Contains(s, "advanced"):
		return "PRO"
	case strings.Contains(s, "enterprise") || strings.Contains(s, "standard") || strings.Contains(s, "business") ||
		strings.HasPrefix(s, "gcp_") || strings.Contains(s, "vertex"):
		return "ENTERPRISE"
	}
	return "FREE"
}

// pickOnboardTier 挑出无需用户自备 GCP 项目的可自动激活档位（如个人免费档 free-tier）。
// 若 allowedTiers 里只有 userDefinedCloudaicompanionProject=true 的 standard-tier，说明免费档不可用，不能自动激活。
func pickOnboardTier(tiers []cloudTier) *cloudTier {
	for i := range tiers {
		if !tiers[i].UserDefinedProject && tiers[i].IsDefault && tiers[i].ID != "" {
			return &tiers[i]
		}
	}
	for i := range tiers {
		if tiers[i].ID == "free-tier" && !tiers[i].UserDefinedProject {
			return &tiers[i]
		}
	}
	for i := range tiers {
		if !tiers[i].UserDefinedProject && tiers[i].ID != "" {
			return &tiers[i]
		}
	}
	return nil
}

func formatIneligibleError(items []ineligibleTier) error {
	if len(items) == 0 {
		return nil
	}
	picked := items[0]
	for _, it := range items {
		if it.ReasonCode == "VALIDATION_REQUIRED" && it.ValidationURL != "" {
			picked = it
			break
		}
		if it.TierID == "free-tier" {
			picked = it
		}
	}
	switch picked.ReasonCode {
	case "UNSUPPORTED_LOCATION":
		return errors.New("地区不支持（UNSUPPORTED_LOCATION）：账号归属国家或当前代理 IP 不在 Antigravity 支持区（请切换美/日/新等代理节点，或检查 Google 账号归属地）")
	case "UNKNOWN_LOCATION":
		return errors.New("无法识别地区（UNKNOWN_LOCATION）：Google 无法确认当前网络或账号所在地区，请更换美/日/新等代理节点后重试")
	case "RESTRICTED_NETWORK":
		return errors.New("当前网络受限（RESTRICTED_NETWORK）：当前代理出口被限制访问 Antigravity，请更换代理节点后重试")
	case "VALIDATION_REQUIRED":
		if picked.ValidationURL != "" {
			return errors.New("账号需要完成安全验证（VALIDATION_REQUIRED）：请在该账号浏览器中完成验证后刷新额度 " + picked.ValidationURL)
		}
		return errors.New("账号需要完成安全验证（VALIDATION_REQUIRED）：请先在该账号浏览器中登录 Google 完成验证后重试")
	case "RESTRICTED_AGE":
		return errors.New("年龄限制（RESTRICTED_AGE）：该账号未满适用年龄或未完成年龄验证，无法使用 Antigravity")
	case "DASHER_USER":
		return errors.New("企业/教育域限制（DASHER_USER）：Google Workspace 账号不支持个人免费档，需由管理员分配许可")
	}
	msg := strings.TrimSpace(picked.ReasonMessage)
	if picked.ReasonCode != "" && msg != "" {
		return fmt.Errorf("账号不符合开通条件（%s）：%s", picked.ReasonCode, msg)
	}
	if msg != "" {
		return errors.New("账号不符合开通条件：" + msg)
	}
	return fmt.Errorf("账号不符合开通条件（%s）", picked.ReasonCode)
}

func (g *googleClient) postSingle(ctx context.Context, u, accessToken string, payload, out any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", upstreamUserAgent)
	return g.do(req, out)
}

func (g *googleClient) getSingle(ctx context.Context, u, accessToken string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("User-Agent", upstreamUserAgent)
	return g.do(req, out)
}

func (g *googleClient) loadCodeAssistRaw(ctx context.Context, accessToken string) (loadCodeAssistResp, string, error) {
	payload := map[string]any{"metadata": map[string]string{"ideType": "ANTIGRAVITY"}}
	var lastErr error
	for _, base := range codeAssistBaseURLs {
		var resp loadCodeAssistResp
		if lastErr = g.postSingle(ctx, base+"/v1internal:loadCodeAssist", accessToken, payload, &resp); lastErr == nil {
			return resp, base, nil
		}
	}
	return loadCodeAssistResp{}, "", lastErr
}

// onboardUser 为符合条件但尚未初始化的新免费号调用 onboardUser 激活托管项目，避免首次未登录 IDE 时查不到额度。
func (g *googleClient) onboardUser(ctx context.Context, preferredBase, accessToken, tierID string) (string, error) {
	bases := make([]string, 0, len(codeAssistBaseURLs))
	if preferredBase != "" {
		bases = append(bases, preferredBase)
	}
	for _, b := range codeAssistBaseURLs {
		if b != preferredBase {
			bases = append(bases, b)
		}
	}
	// free-tier 使用 Google 托管项目，传 cloudaicompanionProject 会触发 Precondition Failed。
	payload := map[string]any{
		"tierId":   tierID,
		"metadata": map[string]string{"ideType": "ANTIGRAVITY"},
	}
	var lro onboardOperation
	var usedBase string
	var lastErr error
	for _, b := range bases {
		if lastErr = g.postSingle(ctx, b+"/v1internal:onboardUser", accessToken, payload, &lro); lastErr == nil {
			usedBase = b
			break
		}
	}
	if usedBase == "" {
		return "", lastErr
	}
	if !lro.Done && lro.Name != "" {
		opPath := strings.TrimPrefix(strings.TrimPrefix(lro.Name, "/"), "v1internal/")
		pollURL := usedBase + "/v1internal/" + opPath
		timer := time.NewTimer(2 * time.Second)
		defer timer.Stop()
		for range 15 {
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-timer.C:
			}
			var next onboardOperation
			if err := g.getSingle(ctx, pollURL, accessToken, &next); err == nil {
				lro = next
				if lro.Done {
					break
				}
			}
			timer.Reset(2 * time.Second)
		}
	}
	if lro.Error != nil && lro.Error.Message != "" {
		return "", fmt.Errorf("激活免费额度失败：%s", lro.Error.Message)
	}
	if lro.Response != nil {
		return string(lro.Response.Project), nil
	}
	return "", nil
}

// resolveCodeAssist 返回 project ID、订阅等级及不满足免费档时的原因。
func (g *googleClient) resolveCodeAssist(ctx context.Context, accessToken string) (project, tier string, ineligible []ineligibleTier, fatalErr error) {
	resp, base, err := g.loadCodeAssistRaw(ctx, accessToken)
	if err != nil {
		return "", "", nil, nil // loadCodeAssist 失败时仍允许后续尝试无 project 查额度
	}
	// 已有活跃档位（已开通的免费号 / Pro / Ultra / Enterprise）
	if resp.PaidTier != nil || resp.CurrentTier != nil {
		raw := resp.PaidTier.label()
		if raw == "" {
			raw = resp.CurrentTier.label()
		}
		if raw == "" {
			raw = "free-tier"
		}
		return resp.Project, normalizeTier(raw), resp.IneligibleTiers, nil
	}
	// 尚未初始化的新号：若存在可自动激活的个人免费档，自动执行 onboardUser
	if onboardTier := pickOnboardTier(resp.AllowedTiers); onboardTier != nil {
		for _, it := range resp.IneligibleTiers {
			if it.ReasonCode == "VALIDATION_REQUIRED" && it.ValidationURL != "" {
				return "", "", resp.IneligibleTiers, formatIneligibleError(resp.IneligibleTiers)
			}
		}
		onboardProj, err := g.onboardUser(ctx, base, accessToken, onboardTier.ID)
		if err != nil {
			if len(resp.IneligibleTiers) > 0 {
				return "", "", resp.IneligibleTiers, formatIneligibleError(resp.IneligibleTiers)
			}
			return "", "", nil, err
		}
		// 重新拉一次 loadCodeAssist 获取激活后的权威 project 与 tier
		if refreshed, _, rerr := g.loadCodeAssistRaw(ctx, accessToken); rerr == nil {
			raw := refreshed.PaidTier.label()
			if raw == "" {
				raw = refreshed.CurrentTier.label()
			}
			if raw == "" {
				raw = onboardTier.label()
			}
			proj := refreshed.Project
			if proj == "" {
				proj = onboardProj
			}
			return proj, normalizeTier(raw), refreshed.IneligibleTiers, nil
		}
		return onboardProj, normalizeTier(onboardTier.label()), resp.IneligibleTiers, nil
	}
	// 既无当前档位，也无可自动激活的免费档：直接返回真实的地区/年龄/验证等限制原因
	if len(resp.IneligibleTiers) > 0 {
		return "", "", resp.IneligibleTiers, formatIneligibleError(resp.IneligibleTiers)
	}
	return resp.Project, "", nil, nil
}

func (g *googleClient) quotaSummary(ctx context.Context, accessToken, project string) ([]QuotaGroup, error) {
	var resp struct {
		Groups []struct {
			DisplayName string `json:"displayName"`
			Buckets     []struct {
				Window            string   `json:"window"`
				DisplayName       string   `json:"displayName"`
				RemainingFraction *float64 `json:"remainingFraction"`
				ResetTime         string   `json:"resetTime"`
			} `json:"buckets"`
		} `json:"groups"`
	}
	payload := map[string]string{}
	if project != "" {
		payload["project"] = project
	}
	if err := g.postInternal(ctx, quotaSummaryURLs, accessToken, payload, &resp); err != nil {
		return nil, err
	}
	groups := make([]QuotaGroup, 0, len(resp.Groups))
	for _, rg := range resp.Groups {
		grp := QuotaGroup{DisplayName: rg.DisplayName}
		for _, b := range rg.Buckets {
			if b.RemainingFraction == nil {
				continue
			}
			grp.Buckets = append(grp.Buckets, QuotaBucket{
				Window: b.Window, DisplayName: b.DisplayName,
				RemainingFraction: *b.RemainingFraction, ResetTime: b.ResetTime,
			})
		}
		groups = append(groups, grp)
	}
	return groups, nil
}

func (g *googleClient) fetchQuota(ctx context.Context, refreshToken string) (QuotaInfo, error) {
	access, err := g.accessToken(ctx, refreshToken)
	if err != nil {
		return QuotaInfo{}, err
	}
	project, tier, ineligible, err := g.resolveCodeAssist(ctx, access)
	if err != nil {
		return QuotaInfo{}, err
	}
	groups, err := g.quotaSummary(ctx, access, project)
	if err != nil {
		var ge *googleError
		if errors.As(err, &ge) && ge.status == http.StatusForbidden && len(ineligible) > 0 &&
			(strings.Contains(ge.body, "SUBSCRIPTION_REQUIRED") || strings.Contains(ge.body, "#3501")) {
			return QuotaInfo{}, formatIneligibleError(ineligible)
		}
		return QuotaInfo{}, fmt.Errorf("查询额度失败：%w", err)
	}
	return QuotaInfo{Tier: tier, Groups: groups}, nil
}
