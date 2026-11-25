package main

import (
	"errors"
	"fmt"
	"path/filepath"
	"testing"
)

func TestServiceDisabledEvidence(t *testing.T) {
	tos := "Error This service has been disabled in this account for violation of Terms of Service. Please submit an appeal.\nError ID: 0d288607-9872-43cf-b127-8eee2bc95fa7-1"
	if id, disabled := serviceDisabledText(tos); !disabled || id != "0d288607-9872-43cf-b127-8eee2bc95fa7-1" {
		t.Fatalf("serviceDisabledText() = %q, %v", id, disabled)
	}

	err := fmt.Errorf("查询额度失败：%w", &googleError{status: 403, body: `{"error":{"details":[{"reason":"ACCOUNT_DISABLED"}]}}`})
	if _, disabled := serviceDisabledFromError(err); !disabled {
		t.Fatal("typed Google ACCOUNT_DISABLED error was not detected")
	}

	for _, text := range []string{
		"连不上 Google（检查代理）：network unreachable",
		"Google 返回 429（RESOURCE_EXHAUSTED）：请求过于频繁",
		"weekly quota exhausted",
		"Google 返回 401（UNAUTHENTICATED）：登录凭证失效",
	} {
		if _, disabled := serviceDisabledText(text); disabled {
			t.Fatalf("non-ToS error misclassified as disabled: %s", text)
		}
	}
}

func TestClassifyCLIProbe(t *testing.T) {
	tests := []struct {
		name       string
		stdout     string
		stderr     string
		runErr     error
		wantStatus string
		wantID     string
	}{
		{
			name:       "real response is available",
			stdout:     `{"status":"SUCCESS","response":"OK\n"}`,
			wantStatus: "available",
		},
		{
			name:       "empty success is unknown",
			stdout:     `{"status":"SUCCESS","response":""}`,
			wantStatus: "unknown",
		},
		{
			name:       "explicit ToS error is disabled",
			stderr:     "This service has been disabled in this account for violation of Terms of Service.\nError ID: abcdef12-3456-7890",
			runErr:     errors.New("exit status 1"),
			wantStatus: "disabled",
			wantID:     "abcdef12-3456-7890",
		},
		{
			name:       "rate limit is unknown",
			stderr:     "RESOURCE_EXHAUSTED: too many requests",
			runErr:     errors.New("exit status 1"),
			wantStatus: "unknown",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			status, id, _ := classifyCLIProbe(tt.stdout, tt.stderr, tt.runErr)
			if status != tt.wantStatus || id != tt.wantID {
				t.Fatalf("classifyCLIProbe() = %q, %q; want %q, %q", status, id, tt.wantStatus, tt.wantID)
			}
		})
	}
}

func TestServiceStatusStoreFlow(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "gam.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()

	acc := Account{Email: "disabled@gmail.com", LoginDate: today(), RiskDays: 7}
	if err := acc.normalize(); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateAccount(&acc); err != nil {
		t.Fatal(err)
	}
	if err := store.SetServiceDisabled(acc.ID, "error-1234"); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkAppeal(acc.ID); err != nil {
		t.Fatal(err)
	}
	// 后续没有 Error ID 的失败检测保留原 ID 和申诉时间。
	if err := store.SetServiceDisabled(acc.ID, ""); err != nil {
		t.Fatal(err)
	}
	got, err := store.GetAccount(acc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !got.ServiceDisabled || got.ServiceErrorID != "error-1234" || got.AppealAt == 0 || got.ServiceCheckedAt == 0 {
		t.Fatalf("unexpected disabled state: %+v", got)
	}

	if err := store.ClearServiceDisabled(acc.ID); err != nil {
		t.Fatal(err)
	}
	got, err = store.GetAccount(acc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ServiceDisabled || got.ServiceErrorID != "" || got.AppealAt != 0 {
		t.Fatalf("service state was not cleared: %+v", got)
	}
}
