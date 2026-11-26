package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
)

const antigravityAppealURL = "https://docs.google.com/forms/d/e/1FAIpQLScOJWibQ_-hYuVv63kJTgEqlgAaOwRLGFTbXm-QY1gz8U0CGA/viewform"

var serviceErrorIDPattern = regexp.MustCompile(`(?i)Error ID:\s*([0-9a-f-]{8,})`)

// preferredProbeModels 按轻量和速度排序，优先挑有剩余额度的 Flash 模型做 1 token 真实对话探测。
var preferredProbeModels = []string{
	"gemini-3.1-flash-lite",
	"gemini-2.5-flash",
	"gemini-3-flash",
}

// serviceDisabledText 只接受 Google 的明确停用证据，避免把网络、代理、限流或额度耗尽误判为封号。
func serviceDisabledText(text string) (errorID string, disabled bool) {
	lower := strings.ToLower(text)
	if !strings.Contains(lower, "account_disabled") &&
		!strings.Contains(lower, `"reason":"tos_violation"`) &&
		!strings.Contains(lower, `"reason": "tos_violation"`) &&
		!strings.Contains(lower, "this service has been disabled in this account for violation of terms of service") {
		return "", false
	}
	if match := serviceErrorIDPattern.FindStringSubmatch(text); len(match) == 2 {
		errorID = match[1]
	}
	return errorID, true
}

func serviceDisabledFromError(err error) (string, bool) {
	if err == nil {
		return "", false
	}
	var googleErr *googleError
	if errors.As(err, &googleErr) {
		if errorID, disabled := serviceDisabledText(googleErr.body); disabled {
			return errorID, true
		}
	}
	return serviceDisabledText(err.Error())
}

type serviceCheckResponse struct {
	Accounts []AccountView `json:"accounts"`
	Status   string        `json:"status"`
	Message  string        `json:"message"`
}

func (a *App) writeServiceCheck(w http.ResponseWriter, status, message string) {
	views, err := a.accountViews()
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, serviceCheckResponse{Accounts: views, Status: status, Message: message})
}

// appealAccount 永远用该账号自己的浏览器打开官方表单，避免申诉到当前登录的其他账号。
func (a *App) appealAccount(w http.ResponseWriter, r *http.Request) {
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
	warning, err := a.launchFor(acc, antigravityAppealURL)
	if err != nil {
		writeErr(w, err)
		return
	}
	if err := a.store.MarkAppeal(id); err != nil {
		writeErr(w, err)
		return
	}
	writeLaunched(w, warning)
}

func probeDetail(text string) string {
	text = strings.TrimSpace(text)
	runes := []rune(text)
	if len(runes) > 800 {
		runes = runes[len(runes)-800:]
	}
	return string(runes)
}

type availableModel struct {
	QuotaInfo *struct {
		RemainingFraction *float64 `json:"remainingFraction"`
	} `json:"quotaInfo"`
}

func (m availableModel) hasQuota() bool {
	return m.QuotaInfo == nil || m.QuotaInfo.RemainingFraction == nil || *m.QuotaInfo.RemainingFraction > 0
}

func pickProbeModel(models map[string]availableModel) string {
	for _, name := range preferredProbeModels {
		if m, ok := models[name]; ok && m.hasQuota() {
			return name
		}
	}
	names := make([]string, 0, len(models))
	for name := range models {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		lower := strings.ToLower(name)
		if strings.Contains(lower, "flash") && !strings.Contains(lower, "disabled") && !strings.HasPrefix(lower, "tab_") && models[name].hasQuota() {
			return name
		}
	}
	for _, name := range preferredProbeModels {
		if _, ok := models[name]; ok {
			return name
		}
	}
	return preferredProbeModels[0]
}

func (g *googleClient) fetchProbeModel(ctx context.Context, accessToken, project string) string {
	payload := map[string]string{}
	if project != "" {
		payload["project"] = project
	}
	var resp struct {
		Models map[string]availableModel `json:"models"`
	}
	for _, base := range codeAssistBaseURLs {
		if err := g.postSingle(ctx, base+"/v1internal:fetchAvailableModels", accessToken, payload, &resp); err == nil && len(resp.Models) > 0 {
			return pickProbeModel(resp.Models)
		}
	}
	return preferredProbeModels[0]
}

// parseSSEProbe 解析 v1internal:streamGenerateContent?alt=sse 的事件流：
// 先匹配明确 ToS 停用，再确认收到真实非思考文本回复；其余错误（如 429、网络中断）均归为 unknown。
func parseSSEProbe(r io.Reader) (status, errorID, detail string) {
	scanner := bufio.NewScanner(io.LimitReader(r, 512<<10))
	scanner.Buffer(make([]byte, 0, 64<<10), 256<<10)
	var rawLines []string
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		if len(rawLines) < 8 {
			rawLines = append(rawLines, line)
		}
		if id, disabled := serviceDisabledText(line); disabled {
			return "disabled", id, probeDetail(line)
		}
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var frame struct {
			Error *struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
				Status  string `json:"status"`
			} `json:"error"`
			Response struct {
				Candidates []struct {
					Content struct {
						Parts []struct {
							Text    string `json:"text"`
							Thought bool   `json:"thought"`
						} `json:"parts"`
					} `json:"content"`
				} `json:"candidates"`
			} `json:"response"`
		}
		if json.Unmarshal([]byte(payload), &frame) != nil {
			continue
		}
		if frame.Error != nil && (frame.Error.Message != "" || frame.Error.Status != "") {
			code := frame.Error.Code
			if code == 0 {
				code = http.StatusBadGateway
			}
			return "unknown", "", probeDetail(summarizeGoogleError(code, payload))
		}
		for _, cand := range frame.Response.Candidates {
			for _, part := range cand.Content.Parts {
				if !part.Thought && strings.TrimSpace(part.Text) != "" {
					return "available", "", ""
				}
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return "unknown", "", probeDetail("读取对话响应失败：" + err.Error())
	}
	if len(rawLines) > 0 {
		joined := strings.Join(rawLines, "\n")
		if id, disabled := serviceDisabledText(joined); disabled {
			return "disabled", id, probeDetail(joined)
		}
		return "unknown", "", probeDetail("模型未返回可识别的回复：" + joined)
	}
	return "unknown", "", "模型未返回任何内容"
}

// probeChat 直接用账号自身的 OAuth access token 向 Cloud Code 发送一条最小真实对话，无需依赖本机 agy 或切号。
func (g *googleClient) probeChat(ctx context.Context, accessToken, project string) (status, errorID, detail string) {
	model := g.fetchProbeModel(ctx, accessToken, project)
	payload := map[string]any{
		"model":     model,
		"userAgent": "antigravity",
		"request": map[string]any{
			"contents": []map[string]any{
				{"role": "user", "parts": []map[string]string{{"text": "Reply with OK only."}}},
			},
			"generationConfig": map[string]any{"maxOutputTokens": 64},
		},
	}
	if project != "" {
		payload["project"] = project
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "unknown", "", err.Error()
	}

	var lastDetail string
	for _, base := range codeAssistBaseURLs {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1internal:streamGenerateContent?alt=sse", bytes.NewReader(body))
		if err != nil {
			return "unknown", "", err.Error()
		}
		req.Header.Set("Authorization", "Bearer "+accessToken)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "text/event-stream")
		req.Header.Set("User-Agent", upstreamUserAgent)

		resp, err := g.http.Do(req)
		if err != nil {
			lastDetail = fmt.Sprintf("连不上 Google（检查代理）：%v", err)
			continue
		}
		if resp.StatusCode/100 != 2 {
			errBody, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
			resp.Body.Close()
			gerr := &googleError{status: resp.StatusCode, body: strings.TrimSpace(string(errBody))}
			if id, disabled := serviceDisabledFromError(gerr); disabled {
				return "disabled", id, probeDetail(gerr.Error())
			}
			// 401 / 403 / 429 属于明确的账号或频控状态，不重复打其它同源端点。
			if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests {
				return "unknown", "", probeDetail(gerr.Error())
			}
			lastDetail = gerr.Error()
			continue
		}
		st, id, det := parseSSEProbe(resp.Body)
		resp.Body.Close()
		if st == "available" || st == "disabled" {
			return st, id, det
		}
		lastDetail = det
	}
	if lastDetail == "" {
		lastDetail = "未收到 Cloud Code 对话响应"
	}
	return "unknown", "", probeDetail(lastDetail)
}

func (a *App) checkAccountService(w http.ResponseWriter, r *http.Request) {
	if !a.serviceCheckMu.TryLock() {
		writeErr(w, errors.New("另一个账号正在做对话检测，请稍后"))
		return
	}
	defer a.serviceCheckMu.Unlock()

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
	if acc.RefreshToken == "" {
		writeErr(w, errors.New("这个账号还没授权，请先点右侧「授权」"))
		return
	}
	st, err := a.store.GetSettings()
	if err != nil {
		writeErr(w, err)
		return
	}
	g, err := newGoogleClient(proxyFor(acc, st))
	if err != nil {
		writeErr(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()

	access, authErr := g.accessToken(ctx, acc.RefreshToken)
	if authErr != nil {
		if errorID, disabled := serviceDisabledFromError(authErr); disabled {
			if err := a.store.SetServiceDisabled(acc.ID, errorID); err != nil {
				log.Printf("保存 %s 的停用状态失败：%v", acc.Email, err)
			}
			_ = a.store.SetQuota(acc.ID, nil, authErr)
			a.writeServiceCheck(w, "disabled", "仍检测到 Antigravity 服务停用，请提交或等待申诉审核")
			return
		}
		_ = a.store.SetQuota(acc.ID, nil, authErr)
		_ = a.store.SetServiceChecked(id)
		writeErr(w, fmt.Errorf("检测未完成：%w", authErr))
		return
	}

	info, project, queryErr := g.fetchQuotaWithAccess(ctx, access)
	if errorID, disabled := serviceDisabledFromError(queryErr); disabled {
		if err := a.store.SetServiceDisabled(acc.ID, errorID); err != nil {
			log.Printf("保存 %s 的停用状态失败：%v", acc.Email, err)
		}
		_ = a.store.SetQuota(acc.ID, &info, queryErr)
		a.writeServiceCheck(w, "disabled", "仍检测到 Antigravity 服务停用，请提交或等待申诉审核")
		return
	}
	if err := a.store.SetQuota(acc.ID, &info, queryErr); err != nil {
		log.Printf("保存 %s 的额度失败：%v", acc.Email, err)
	}
	if queryErr != nil {
		_ = a.store.SetServiceChecked(id)
		writeErr(w, fmt.Errorf("检测未完成：%w", queryErr))
		return
	}

	status, errorID, detail := g.probeChat(ctx, access, project)
	switch status {
	case "available":
		if err := a.store.ClearServiceDisabled(id); err != nil {
			writeErr(w, err)
			return
		}
		msg := "真实对话检测正常，Antigravity 服务可用"
		if acc.ServiceDisabled {
			msg = "真实对话检测通过，Antigravity 已恢复可用"
		}
		a.writeServiceCheck(w, "available", msg)
	case "disabled":
		if err := a.store.SetServiceDisabled(id, errorID); err != nil {
			writeErr(w, err)
			return
		}
		msg := "检测到 Antigravity 对话服务已被停用，请提交申诉"
		if acc.ServiceDisabled {
			msg = "真实对话仍返回服务停用，请提交或等待申诉审核"
		}
		a.writeServiceCheck(w, "disabled", msg)
	default:
		_ = a.store.SetServiceChecked(id)
		writeErr(w, errors.New("对话检测未完成："+detail))
	}
}
