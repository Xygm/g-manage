package main

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func fakeIDToken(email string) string {
	claims, _ := json.Marshal(map[string]string{"email": email})
	return "eyJhbGciOiJSUzI1NiJ9." + base64.RawURLEncoding.EncodeToString(claims) + ".sig"
}

func newStateDB(t *testing.T, items map[string]string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "User", "globalStorage", "state.vscdb")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)`); err != nil {
		t.Fatal(err)
	}
	for k, v := range items {
		if _, err := db.Exec(`INSERT INTO ItemTable (key, value) VALUES (?, ?)`, k, v); err != nil {
			t.Fatal(err)
		}
	}
	return path
}

func itemValue(t *testing.T, path, key string) (string, bool) {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var v string
	err = db.QueryRow(`SELECT value FROM ItemTable WHERE key = ?`, key).Scan(&v)
	return v, err == nil
}

// 切号要替换登录条目，同时保留同一 Topic 里客户端自己的其它条目。
func TestInjectStateDBReplacesLoginKeepsOtherEntries(t *testing.T) {
	old := agyCreds{Email: "old@gmail.com", AccessToken: "ya29.old", RefreshToken: "1//old", Expiry: time.Unix(1700000000, 0)}
	topic := append(topicEntry("someOtherSentinel", []byte("keep-me")), topicEntry(sentinelOAuth, encodeOAuthTokenInfo(old))...)
	path := newStateDB(t, map[string]string{
		topicOAuthToken:                         base64.StdEncoding.EncodeToString(topic),
		"jetskiStateSync.agentManagerInitState": "stale",
	})

	c := agyCreds{Email: "new@gmail.com", AccessToken: "ya29.new", RefreshToken: "1//new", IDToken: fakeIDToken("new@gmail.com"), Expiry: time.Now().Add(time.Hour)}
	if err := injectStateDB(path, c); err != nil {
		t.Fatal(err)
	}

	rt, email, err := readStateDB(path)
	if err != nil || rt != "1//new" || email != "new@gmail.com" {
		t.Fatalf("readStateDB = %q %q %v", rt, email, err)
	}
	raw, _ := itemValue(t, path, topicOAuthToken)
	got, _ := base64.StdEncoding.DecodeString(raw)
	if p, ok := topicPayload(got, "someOtherSentinel"); !ok || string(p) != "keep-me" {
		t.Fatalf("other entry lost: %q %v", p, ok)
	}
	fields, _ := pbParse(got)
	if len(fields) != 2 {
		t.Fatalf("topic has %d entries, want 2 (old login entry must be replaced)", len(fields))
	}
	if _, ok := itemValue(t, path, "jetskiStateSync.agentManagerInitState"); ok {
		t.Fatal("stale agentManagerInitState should be deleted")
	}
	if v, _ := itemValue(t, path, "agy.onboarding.lastLoginUsername"); v != "new@gmail.com" {
		t.Fatalf("lastLoginUsername = %q", v)
	}
	if _, ok := itemValue(t, path, topicEnterprise); ok {
		t.Fatal("personal account must not carry a GCP project preference")
	}
}

// 账号没有 id_token 时，邮箱要能从 userStatus 里读出来。
func TestReadStateDBEmailFallsBackToUserStatus(t *testing.T) {
	c := agyCreds{Email: "a@gmail.com", AccessToken: "ya29.x", RefreshToken: "1//x", Expiry: time.Now()}
	path := newStateDB(t, nil)
	if err := injectStateDB(path, c); err != nil {
		t.Fatal(err)
	}
	if rt, email, err := readStateDB(path); err != nil || rt != "1//x" || email != "a@gmail.com" {
		t.Fatalf("readStateDB = %q %q %v", rt, email, err)
	}
}

func TestApplyDeviceProfileKeepsOtherKeysAndSyncsStateDB(t *testing.T) {
	statePath := newStateDB(t, nil)
	d := desktopClient{dataDir: filepath.Dir(filepath.Dir(filepath.Dir(statePath)))}
	orig := `{"theme":"dark","telemetry":{"machineId":"m0","macMachineId":"a0","devDeviceId":"d0","sqmId":"s0","extra":"x"},"telemetry.machineId":"m0"}`
	if err := os.WriteFile(d.storagePath(), []byte(orig), 0o644); err != nil {
		t.Fatal(err)
	}
	if p, err := readDeviceProfile(d.storagePath()); err != nil || p.MachineID != "m0" || p.SqmID != "s0" {
		t.Fatalf("readDeviceProfile original = %+v %v", p, err)
	}

	p := newDeviceProfile()
	if err := applyDeviceProfile(d, p); err != nil {
		t.Fatal(err)
	}
	got, err := readDeviceProfile(d.storagePath())
	if err != nil || got != p {
		t.Fatalf("readDeviceProfile = %+v %v, want %+v", got, err, p)
	}
	var m map[string]any
	raw, _ := os.ReadFile(d.storagePath())
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if m["theme"] != "dark" || m["telemetry"].(map[string]any)["extra"] != "x" {
		t.Fatalf("unrelated keys lost: %s", raw)
	}
	if m["telemetry.devDeviceId"] != p.DevDeviceID || m["storage.serviceMachineId"] != p.DevDeviceID {
		t.Fatalf("flat keys not synced: %s", raw)
	}
	if v, _ := itemValue(t, statePath, "storage.serviceMachineId"); v != p.DevDeviceID {
		t.Fatalf("state.vscdb serviceMachineId = %q", v)
	}
}

func TestCredentialJSONRoundTrip(t *testing.T) {
	c := agyCreds{Email: "a@gmail.com", AccessToken: "ya29.a", RefreshToken: "1//a", IDToken: fakeIDToken("A@gmail.com"), Expiry: time.Now()}
	rt, email, err := parseCredential(credentialJSON(c))
	if err != nil || rt != "1//a" || email != "a@gmail.com" {
		t.Fatalf("parseCredential = %q %q %v", rt, email, err)
	}
}

func quotaJSON(tier string, gemini, claude float64) string {
	q := QuotaInfo{Tier: tier, Groups: []QuotaGroup{
		{DisplayName: "Gemini Models", Buckets: []QuotaBucket{{Window: "5h", RemainingFraction: gemini}, {Window: "weekly", RemainingFraction: 1}}},
		{DisplayName: "Claude and GPT models", Buckets: []QuotaBucket{{Window: "5h", RemainingFraction: claude}, {Window: "weekly", RemainingFraction: 1}}},
	}}
	b, _ := json.Marshal(q)
	return string(b)
}

func TestNextCandidates(t *testing.T) {
	now := "2026-11-24"
	base := func(id int64, tier string, gemini, claude float64) Account {
		return Account{ID: id, Email: "x", RefreshToken: "rt", LoginDate: "2026-01-01", RiskDays: 7, PwdChangedDate: "2026-02-01",
			QuotaJSON: quotaJSON(tier, gemini, claude)}
	}
	inRisk := base(1, "ULTRA", 1, 1)
	inRisk.LoginDate, inRisk.PwdChangedDate = "2026-11-23", ""
	current := base(2, "ULTRA", 1, 1)
	lowClaude := base(3, "ULTRA", 1, 0.05)
	freeFull := base(4, "FREE", 1, 1)
	proHalf := base(5, "PRO", 0.5, 0.6)
	proFullRecent := base(6, "PRO", 1, 1)
	proFullRecent.SwitchedAt = 200
	proFullOld := base(7, "PRO", 1, 1)
	proFullOld.SwitchedAt = 100
	failed := base(8, "ULTRA", 1, 1)
	failed.QuotaError = "boom"

	st := Settings{NextPool: poolAny, NextThreshold: 10}
	got := nextCandidates([]Account{inRisk, current, lowClaude, freeFull, proHalf, proFullRecent, proFullOld, failed}, st, now, current.ID)
	var ids []int64
	for _, a := range got {
		ids = append(ids, a.ID)
	}
	want := []int64{7, 6, 5, 4} // 风控期、当前号、Claude 池不足、查询失败的都排除；PRO 优先，剩余多的优先，同分时最久没切的优先
	if len(ids) != len(want) {
		t.Fatalf("candidates = %v, want %v", ids, want)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("candidates = %v, want %v", ids, want)
		}
	}

	st.NextPool = poolGemini
	if got := nextCandidates([]Account{lowClaude}, st, now, 0); len(got) != 1 {
		t.Fatal("gemini pool should ignore the low Claude quota")
	}
}
