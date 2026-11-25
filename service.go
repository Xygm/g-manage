package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

const antigravityAppealURL = "https://docs.google.com/forms/d/e/1FAIpQLScOJWibQ_-hYuVv63kJTgEqlgAaOwRLGFTbXm-QY1gz8U0CGA/viewform"

var serviceErrorIDPattern = regexp.MustCompile(`(?i)Error ID:\s*([0-9a-f-]{8,})`)

// serviceDisabledText 只接受 Google 的明确停用证据，避免把网络、代理、限流或额度耗尽误判为封号。
func serviceDisabledText(text string) (errorID string, disabled bool) {
	lower := strings.ToLower(text)
	if !strings.Contains(lower, "account_disabled") &&
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

func (a *App) currentCLIAccount(id int64) bool {
	if _, err := exec.LookPath("agy"); err != nil {
		return false
	}
	statuses, err := a.clientStatuses()
	if err != nil {
		return false
	}
	for _, status := range statuses {
		if status.Target == targetCLI && status.AccountID == id {
			return true
		}
	}
	return false
}

func probeDetail(text string) string {
	text = strings.TrimSpace(text)
	runes := []rune(text)
	if len(runes) > 800 {
		runes = runes[len(runes)-800:]
	}
	return string(runes)
}

// classifyCLIProbe 先匹配明确停用，再接受成功的真实模型回复；其他输出都属于未知。
func classifyCLIProbe(stdout, stderr string, runErr error) (status, errorID, detail string) {
	combined := stdout + "\n" + stderr
	if errorID, disabled := serviceDisabledText(combined); disabled {
		return "disabled", errorID, probeDetail(combined)
	}
	if runErr == nil {
		var envelope struct {
			Status   string `json:"status"`
			Response string `json:"response"`
			Error    string `json:"error"`
		}
		if json.Unmarshal([]byte(strings.TrimSpace(stdout)), &envelope) == nil {
			if envelope.Status == "SUCCESS" && strings.TrimSpace(envelope.Response) != "" {
				return "available", "", ""
			}
			if envelope.Error != "" {
				detail = envelope.Error
			}
		}
	}
	if detail == "" {
		switch {
		case strings.TrimSpace(stderr) != "":
			detail = stderr
		case runErr != nil:
			detail = runErr.Error()
		case strings.TrimSpace(stdout) != "":
			detail = stdout
		default:
			detail = "agy 没有返回可识别的结果"
		}
	}
	return "unknown", "", probeDetail(detail)
}

func (a *App) runCLIProbe(ctx context.Context) (string, string, string) {
	cmd := exec.CommandContext(ctx, "agy",
		"-p", "Reply with OK only. Do not call any tools.",
		"--output-format", "json",
		"--print-timeout", "60s",
		"--mode", "plan",
	)
	cmd.Dir = a.dataDir
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	return classifyCLIProbe(stdout.String(), stderr.String(), runErr)
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
	st, err := a.store.GetSettings()
	if err != nil {
		writeErr(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()

	queryErr := a.refreshQuota(ctx, acc, st)
	if _, disabled := serviceDisabledFromError(queryErr); disabled {
		a.writeServiceCheck(w, "disabled", "仍检测到 Antigravity 服务停用，请提交或等待申诉审核")
		return
	}
	if queryErr != nil {
		_ = a.store.SetServiceChecked(id)
		writeErr(w, fmt.Errorf("检测未完成：%w", queryErr))
		return
	}

	if !a.currentCLIAccount(id) {
		if err := a.store.SetServiceChecked(id); err != nil {
			writeErr(w, err)
			return
		}
		a.writeServiceCheck(w, "quota_ok", "额度接口已恢复；请将 CLI 切到此账号后再做对话检测")
		return
	}

	status, errorID, detail := a.runCLIProbe(ctx)
	if !a.currentCLIAccount(id) {
		_ = a.store.SetServiceChecked(id)
		writeErr(w, errors.New("检测期间 CLI 登录账号发生变化，请重新检测"))
		return
	}
	switch status {
	case "available":
		if err := a.store.ClearServiceDisabled(id); err != nil {
			writeErr(w, err)
			return
		}
		a.writeServiceCheck(w, "available", "真实对话检测成功，Antigravity 已恢复可用")
	case "disabled":
		if err := a.store.SetServiceDisabled(id, errorID); err != nil {
			writeErr(w, err)
			return
		}
		a.writeServiceCheck(w, "disabled", "真实对话仍返回服务停用，请提交或等待申诉审核")
	default:
		_ = a.store.SetServiceChecked(id)
		writeErr(w, errors.New("对话检测未完成："+detail))
	}
}
