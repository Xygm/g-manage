package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func withMockGoogleEndpoints(t *testing.T, srvURL string) {
	t.Helper()
	origBases := codeAssistBaseURLs
	origQuota := quotaSummaryURLs
	codeAssistBaseURLs = []string{srvURL}
	quotaSummaryURLs = []string{srvURL + "/v1internal:retrieveUserQuotaSummary"}
	t.Cleanup(func() {
		codeAssistBaseURLs = origBases
		quotaSummaryURLs = origQuota
	})
}

func TestFetchQuota_UnsupportedLocationIneligible(t *testing.T) {
	var onboardCalled, quotaCalled atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1internal:loadCodeAssist":
			// 复现 flyingbobibobibo@gmail.com 的真实 Google 返回
			w.Write([]byte(`{
				"allowedTiers": [{
					"id": "standard-tier",
					"name": "Antigravity",
					"userDefinedCloudaicompanionProject": true,
					"isDefault": true
				}],
				"ineligibleTiers": [{
					"reasonCode": "UNSUPPORTED_LOCATION",
					"reasonMessage": "Your current account is not eligible for Antigravity, because it is not currently available in your location.",
					"tierId": "free-tier",
					"tierName": "Antigravity"
				}]
			}`))
		case "/v1internal:onboardUser":
			onboardCalled.Store(true)
			w.WriteHeader(http.StatusForbidden)
		case "/v1internal:retrieveUserQuotaSummary":
			quotaCalled.Store(true)
			w.WriteHeader(http.StatusForbidden)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	withMockGoogleEndpoints(t, srv.URL)

	g := &googleClient{http: srv.Client()}
	_, _, _, err := g.resolveCodeAssist(context.Background(), "fake-access-token")
	if err == nil {
		t.Fatal("expected UNSUPPORTED_LOCATION error, got nil")
	}
	if !strings.Contains(err.Error(), "UNSUPPORTED_LOCATION") || !strings.Contains(err.Error(), "地区不支持") {
		t.Fatalf("unexpected error: %v", err)
	}
	if onboardCalled.Load() {
		t.Fatal("onboardUser should not be called when only userDefinedProject standard-tier is allowed")
	}
	if quotaCalled.Load() {
		t.Fatal("retrieveUserQuotaSummary should not be called")
	}
}

func TestFetchQuota_AutoOnboardEligibleFreeAccount(t *testing.T) {
	var loadCalls, pollCalls atomic.Int32
	var receivedQuotaProject string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1internal:loadCodeAssist":
			n := loadCalls.Add(1)
			if n == 1 {
				// 全新合规免费号：尚未 onboard，allowedTiers 含 free-tier
				w.Write([]byte(`{
					"allowedTiers": [{
						"id": "free-tier",
						"name": "Antigravity",
						"isDefault": true
					}]
				}`))
				return
			}
			w.Write([]byte(`{
				"cloudaicompanionProject": "managed-free-proj-123",
				"currentTier": {"id": "free-tier", "name": "Antigravity"}
			}`))
		case "/v1internal:onboardUser":
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			if body["tierId"] != "free-tier" {
				t.Errorf("expected tierId=free-tier, got %v", body["tierId"])
			}
			if _, hasProj := body["cloudaicompanionProject"]; hasProj {
				t.Errorf("free-tier onboardUser must not send cloudaicompanionProject")
			}
			w.Write([]byte(`{"name": "operations/onboard-op-1", "done": false}`))
		case "/v1internal/operations/onboard-op-1":
			pollCalls.Add(1)
			w.Write([]byte(`{
				"name": "operations/onboard-op-1",
				"done": true,
				"response": {"cloudaicompanionProject": {"id": "managed-free-proj-123"}}
			}`))
		case "/v1internal:retrieveUserQuotaSummary":
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			receivedQuotaProject = body["project"]
			w.Write([]byte(`{
				"groups": [{
					"displayName": "Gemini Models",
					"buckets": [{"window": "weekly", "remainingFraction": 1.0, "resetTime": "2026-12-01T00:00:00Z"}]
				}]
			}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	withMockGoogleEndpoints(t, srv.URL)

	g := &googleClient{http: srv.Client()}
	proj, tier, _, err := g.resolveCodeAssist(context.Background(), "fake-access-token")
	if err != nil {
		t.Fatalf("resolveCodeAssist error: %v", err)
	}
	if proj != "managed-free-proj-123" || tier != "FREE" {
		t.Fatalf("expected proj=managed-free-proj-123 tier=FREE, got proj=%q tier=%q", proj, tier)
	}
	if pollCalls.Load() != 1 {
		t.Fatalf("expected 1 LRO poll call, got %d", pollCalls.Load())
	}
	groups, err := g.quotaSummary(context.Background(), "fake-access-token", proj)
	if err != nil {
		t.Fatalf("quotaSummary error: %v", err)
	}
	if receivedQuotaProject != "managed-free-proj-123" || len(groups) != 1 {
		t.Fatalf("unexpected quota result: proj=%q groups=%+v", receivedQuotaProject, groups)
	}
}

func TestFetchQuota_ValidationRequiredIncludesURL(t *testing.T) {
	err := formatIneligibleError([]ineligibleTier{{
		ReasonCode:    "VALIDATION_REQUIRED",
		ReasonMessage: "Please verify your account",
		TierID:        "free-tier",
		ValidationURL: "https://accounts.google.com/signin/continue?sarp=1",
	}})
	if err == nil || !strings.Contains(err.Error(), "VALIDATION_REQUIRED") || !strings.Contains(err.Error(), "https://accounts.google.com/") {
		t.Fatalf("unexpected validation error: %v", err)
	}
}

func TestSummarizeGoogleError_3501(t *testing.T) {
	raw := `{"error":{"code":403,"message":"You do not have a valid license of this product. (#3501)","status":"PERMISSION_DENIED","details":[{"reason":"SUBSCRIPTION_REQUIRED"}]}}`
	got := summarizeGoogleError(403, raw)
	if !strings.Contains(got, "#3501") || strings.Contains(got, `"details"`) {
		t.Fatalf("expected clean Chinese summary, got: %s", got)
	}
}

func TestAllowGoogleURL(t *testing.T) {
	if _, ok := allowGoogleURL("https://accounts.google.com/verify?x=1"); !ok {
		t.Fatal("expected accounts.google.com https URL to be allowed")
	}
	if _, ok := allowGoogleURL("http://accounts.google.com/verify"); ok {
		t.Fatal("http should be rejected")
	}
	if _, ok := allowGoogleURL("https://evilgoogle.com/verify"); ok {
		t.Fatal("non-google domain should be rejected")
	}
}

// Google 返回的邮箱是 Gmail 规范写法；用户录入时带点或大写也要认成同一个号，否则授权会被误判为选错账号。
func TestSameGoogleAccount(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"t.homaskuzmin95637@gmail.com", "thomaskuzmin95637@gmail.com", true},
		{"Tom.Lee+ag@googlemail.com", "tomlee@gmail.com", true},
		{"t.om@example.com", "tom@example.com", false},
		{"a@gmail.com", "b@gmail.com", false},
	}
	for _, c := range cases {
		if got := sameGoogleAccount(c.a, c.b); got != c.want {
			t.Errorf("sameGoogleAccount(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

// 403 VALIDATION_REQUIRED 的验证入口在 google.rpc.Help 的 links 里，要带进报错文字，界面才能给出「去验证」按钮。
func TestSummarizeGoogleError_ValidationLink(t *testing.T) {
	body := `{"error":{"code":403,"message":"Verify your account to continue.","status":"PERMISSION_DENIED","details":[
		{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"VALIDATION_REQUIRED","domain":"cloudcode-pa.googleapis.com"},
		{"@type":"type.googleapis.com/google.rpc.Help","links":[
			{"description":"Verify your account","url":"https://accounts.google.com/v3/signin/continue?plt=abc&authuser=0"},
			{"description":"Learn more","url":"https://support.google.com/accounts?p=al_alert"}]}]}}`
	got := summarizeGoogleError(403, body)
	if !strings.Contains(got, "VALIDATION_REQUIRED") || !strings.HasSuffix(got, " https://accounts.google.com/v3/signin/continue?plt=abc&authuser=0") {
		t.Fatalf("got %q", got)
	}
}
