package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
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

	tosReason := &googleError{status: 403, body: `{"error":{"code":403,"status":"PERMISSION_DENIED","details":[{"reason":"TOS_VIOLATION"}]}}`}
	if _, disabled := serviceDisabledFromError(tosReason); !disabled {
		t.Fatal("TOS_VIOLATION reason was not detected")
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

func TestParseSSEProbe(t *testing.T) {
	tests := []struct {
		name       string
		stream     string
		wantStatus string
		wantID     string
	}{
		{
			name: "thought followed by real text is available",
			stream: `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"thought":true,"text":"thinking"}]}}]}}` + "\n\n" +
				`data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"OK"}]}}]}}` + "\n\n",
			wantStatus: "available",
		},
		{
			name:       "thought only without reply text is unknown",
			stream:     `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"thought":true,"text":"thinking"}]}}]}}` + "\n\n",
			wantStatus: "unknown",
		},
		{
			name:       "explicit ToS error in stream is disabled",
			stream:     "data: {\"error\":{\"code\":403,\"message\":\"This service has been disabled in this account for violation of Terms of Service.\\nError ID: abcdef12-3456-7890\"}}\n\n",
			wantStatus: "disabled",
			wantID:     "abcdef12-3456-7890",
		},
		{
			name:       "rate limit in stream is unknown",
			stream:     `data: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"too many requests"}}` + "\n\n",
			wantStatus: "unknown",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			status, id, _ := parseSSEProbe(strings.NewReader(tt.stream))
			if status != tt.wantStatus || id != tt.wantID {
				t.Fatalf("parseSSEProbe() = %q, %q; want %q, %q", status, id, tt.wantStatus, tt.wantID)
			}
		})
	}
}

func TestProbeChat_DirectCloudCode(t *testing.T) {
	t.Run("suspended account returns disabled without retrying all bases", func(t *testing.T) {
		calls := 0
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			switch r.URL.Path {
			case "/v1internal:fetchAvailableModels":
				w.Write([]byte(`{"models":{"gemini-3.1-flash-lite":{"quotaInfo":{"remainingFraction":1}}}}`))
			case "/v1internal:streamGenerateContent":
				calls++
				w.WriteHeader(http.StatusForbidden)
				w.Write([]byte(`{"error":{"code":403,"message":"This service has been disabled in this account for violation of Terms of Service. Please submit an appeal.\nError ID: 99887766-abcd","status":"PERMISSION_DENIED","details":[{"reason":"TOS_VIOLATION"}]}}`))
			default:
				http.NotFound(w, r)
			}
		}))
		defer srv.Close()
		origBases := codeAssistBaseURLs
		codeAssistBaseURLs = []string{srv.URL, srv.URL + "/backup"}
		t.Cleanup(func() { codeAssistBaseURLs = origBases })

		g := &googleClient{http: srv.Client()}
		status, id, _ := g.probeChat(context.Background(), "tok", "proj-1")
		if status != "disabled" || id != "99887766-abcd" {
			t.Fatalf("probeChat() = %q, %q; want disabled, 99887766-abcd", status, id)
		}
		if calls != 1 {
			t.Fatalf("expected 1 generate call, got %d", calls)
		}
	})

	t.Run("healthy account returns available and picks model with quota", func(t *testing.T) {
		var usedModel string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/v1internal:fetchAvailableModels":
				w.Header().Set("Content-Type", "application/json")
				w.Write([]byte(`{"models":{
					"gemini-3.1-flash-lite":{"quotaInfo":{"remainingFraction":0}},
					"gemini-2.5-flash":{"quotaInfo":{"remainingFraction":0.8}}
				}}`))
			case "/v1internal:streamGenerateContent":
				var req struct {
					Model string `json:"model"`
				}
				_ = readRequestBodyJSON(r, &req)
				usedModel = req.Model
				w.Header().Set("Content-Type", "text/event-stream")
				w.Write([]byte("data: {\"response\":{\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"OK\"}]}}]}}\n\n"))
			default:
				http.NotFound(w, r)
			}
		}))
		defer srv.Close()
		withMockGoogleEndpoints(t, srv.URL)

		g := &googleClient{http: srv.Client()}
		status, _, detail := g.probeChat(context.Background(), "tok", "proj-1")
		if status != "available" {
			t.Fatalf("probeChat() = %q (%s); want available", status, detail)
		}
		if usedModel != "gemini-2.5-flash" {
			t.Fatalf("expected model gemini-2.5-flash (with remaining quota), got %q", usedModel)
		}
	})
}

func readRequestBodyJSON(r *http.Request, out any) error {
	defer r.Body.Close()
	return json.NewDecoder(r.Body).Decode(out)
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
