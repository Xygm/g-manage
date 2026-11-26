package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
)

func newTestApp(t *testing.T) *App {
	t.Helper()
	dir := t.TempDir()
	st, err := OpenStore(filepath.Join(dir, "accounts.db"))
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	t.Cleanup(func() { st.db.Close() })
	return &App{
		store:   st,
		dataDir: dir,
		addr:    "127.0.0.1:18080",
		pending: map[string]pendingAuth{},
	}
}

func doAppJSON(t *testing.T, handler http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatalf("encode body: %v", err)
		}
	}
	req := httptest.NewRequest(method, "http://127.0.0.1:18080"+path, &buf)
	req.Host = "127.0.0.1:18080"
	req.Header.Set("X-Requested-With", "gam")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestPerksPatchMergeAndClear(t *testing.T) {
	app := newTestApp(t)
	h := app.routes()

	acc := Account{Email: "pro1@gmail.com", LoginDate: "2026-11-20", RiskDays: 7}
	if err := acc.normalize(); err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if err := app.store.CreateAccount(&acc); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}
	idStr := strconv.FormatInt(acc.ID, 10)

	// 1. 设置自动续费与扣费日，应自动锁定 billing_manual=true
	rec := doAppJSON(t, h, http.MethodPatch, "/api/accounts/"+idStr+"/perks", map[string]any{
		"tier_override": "pro",
		"billing_state": "auto_renew",
		"renewal_date":  "2026-11-29",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("step 1 status=%d body=%s", rec.Code, rec.Body.String())
	}
	var v AccountView
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("unmarshal view: %v", err)
	}
	if v.Perks == nil || v.Perks.TierOverride != "PRO" || v.Perks.BillingState != "auto_renew" || v.Perks.RenewalDate != "2026-11-29" || !v.Perks.BillingManual {
		t.Fatalf("unexpected perks after step 1: %+v", v.Perks)
	}

	// 2. 单独标记本月 API 赠金已领 + Flow 积分，不应冲掉已有的账期与档位
	rec = doAppJSON(t, h, http.MethodPatch, "/api/accounts/"+idStr+"/perks", map[string]any{
		"api_credit_claimed_month": "2026-11",
		"flow_credits":             1050,
		"colab_cu":                 200.5,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("step 2 status=%d body=%s", rec.Code, rec.Body.String())
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &v)
	if v.Perks == nil || v.Perks.BillingState != "auto_renew" || v.Perks.APICreditClaimedMonth != "2026-11" ||
		v.Perks.FlowCredits == nil || *v.Perks.FlowCredits != 1050 || v.Perks.ColabCU == nil || *v.Perks.ColabCU != 200.5 {
		t.Fatalf("unexpected perks after step 2: %+v", v.Perks)
	}

	// 3. 非法格式应返回 400 且不破坏已有数据
	bad := doAppJSON(t, h, http.MethodPatch, "/api/accounts/"+idStr+"/perks", map[string]any{
		"renewal_date": "2026/13/40",
	})
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid date, got %d", bad.Code)
	}

	// 4. 全部清空后 perks 回归 nil（不留空 JSON 对象）
	rec = doAppJSON(t, h, http.MethodPatch, "/api/accounts/"+idStr+"/perks", map[string]any{
		"tier_override":            "",
		"billing_state":            "",
		"renewal_date":             "",
		"api_credit_claimed_month": "",
		"clear_flow_credits":       true,
		"clear_colab_cu":           true,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("step 4 status=%d body=%s", rec.Code, rec.Body.String())
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &v)
	if v.Perks != nil {
		t.Fatalf("expected nil perks when empty, got %+v", v.Perks)
	}
}

func TestUpdatePerksConcurrentNoLostUpdate(t *testing.T) {
	app := newTestApp(t)
	acc := Account{Email: "race@gmail.com", LoginDate: "2026-11-20", RiskDays: 7}
	_ = acc.normalize()
	if err := app.store.CreateAccount(&acc); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}

	var wg sync.WaitGroup
	wg.Add(4)
	go func() {
		defer wg.Done()
		_, _ = app.store.UpdatePerks(acc.ID, func(p *AccountPerks) (bool, error) {
			p.BillingState = "cancelled"
			p.RenewalDate = "2026-12-20"
			p.BillingManual = true
			return false, nil
		})
	}()
	go func() {
		defer wg.Done()
		_, _ = app.store.UpdatePerks(acc.ID, func(p *AccountPerks) (bool, error) {
			v := 1045
			p.FlowCredits = &v
			return true, nil
		})
	}()
	go func() {
		defer wg.Done()
		_, _ = app.store.UpdatePerks(acc.ID, func(p *AccountPerks) (bool, error) {
			cu := 1000.0
			p.ColabCU = &cu
			return true, nil
		})
	}()
	go func() {
		defer wg.Done()
		_, _ = app.store.UpdatePerks(acc.ID, func(p *AccountPerks) (bool, error) {
			p.APICreditClaimedMonth = "2026-11"
			return false, nil
		})
	}()
	wg.Wait()

	saved, err := app.store.GetAccount(acc.ID)
	if err != nil {
		t.Fatalf("GetAccount: %v", err)
	}
	v := app.view(saved, "2026-11-26")
	if v.Perks == nil || v.Perks.BillingState != "cancelled" || v.Perks.APICreditClaimedMonth != "2026-11" ||
		v.Perks.FlowCredits == nil || *v.Perks.FlowCredits != 1045 || v.Perks.ColabCU == nil || *v.Perks.ColabCU != 1000 || v.PerksAt == 0 {
		t.Fatalf("concurrent update lost fields: perks=%+v perks_at=%d", v.Perks, v.PerksAt)
	}
}

func TestSingleAccountDetachChromeAndOpenTargets(t *testing.T) {
	app := newTestApp(t)
	h := app.routes()

	a1 := Account{Email: "c1@gmail.com", LoginDate: "2026-11-20", RiskDays: 7, ProfileDir: "/tmp/chrome", ChromeProfile: "Profile 1"}
	a2 := Account{Email: "c2@gmail.com", LoginDate: "2026-11-20", RiskDays: 7, ProfileDir: "/tmp/chrome", ChromeProfile: "Profile 2"}
	_ = a1.normalize()
	_ = a2.normalize()
	_ = app.store.CreateAccount(&a1)
	_ = app.store.CreateAccount(&a2)

	rec := doAppJSON(t, h, http.MethodPost, "/api/accounts/"+strconv.FormatInt(a1.ID, 10)+"/detach-chrome", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("detach single status=%d body=%s", rec.Code, rec.Body.String())
	}
	s1, _ := app.store.GetAccount(a1.ID)
	s2, _ := app.store.GetAccount(a2.ID)
	if s1.ChromeProfile != "" || s1.ProfileDir != "" {
		t.Fatalf("a1 should be detached, got dir=%q profile=%q", s1.ProfileDir, s1.ChromeProfile)
	}
	if s2.ChromeProfile != "Profile 2" {
		t.Fatalf("a2 should remain untouched, got profile=%q", s2.ChromeProfile)
	}

	for _, target := range []string{"one", "subscriptions", "flow", "colab", "benefits", "family"} {
		if openTargets[target] == "" {
			t.Fatalf("missing openTarget %q", target)
		}
	}
}
