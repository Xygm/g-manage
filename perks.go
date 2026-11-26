package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strings"
	"time"
)

const monthLayout = "2006-01"

// AccountPerks 记录 Google AI Pro / Ultra 会员的账期防反撸状态与附赠权益。
type AccountPerks struct {
	// 档位：支持未做 Antigravity OAuth 的纯会员号，或细分 Ultra 5x / 20x
	TierOverride string `json:"tier_override,omitempty"` // "" | "FREE" | "PRO" | "ULTRA" | "ULTRA_5X" | "ULTRA_20X"
	WebTier      string `json:"web_tier,omitempty"`      // 网页端识别到的会员档位

	// 1. 订阅账期与防反撸
	BillingState  string `json:"billing_state,omitempty"`  // "" | "auto_renew" | "cancelled" | "expired"
	RenewalDate   string `json:"renewal_date,omitempty"`   // YYYY-MM-DD（本地日历日）
	BillingSource string `json:"billing_source,omitempty"` // "" | "google" | "play_or_carrier"
	BillingManual bool   `json:"billing_manual,omitempty"` // true 时自动巡检不覆盖手动锁定的账期与续费状态

	// 2. Flow 月度 AI 积分
	FlowCredits     *int   `json:"flow_credits,omitempty"`
	FlowNextGrantAt string `json:"flow_next_grant_at,omitempty"`

	// 3. Colab 计算单元（CU）
	ColabCU         *float64 `json:"colab_cu,omitempty"`
	ColabGPUs       []string `json:"colab_gpus,omitempty"`        // 可用高端 GPU，如 ["H100","A100","L4"]
	ColabObservedAt string   `json:"colab_observed_at,omitempty"` // 首次观察到正余额的日期 YYYY-MM-DD
	ColabNoteDate   string   `json:"colab_note_date,omitempty"`   // 用户可选手填的过期提醒日 YYYY-MM-DD

	// 4. API 月度美金赠金（按 YYYY-MM 记录，跨月前端自动复位为本月待领）
	APICreditClaimedMonth string   `json:"api_credit_claimed_month,omitempty"`
	APICreditBalance      *float64 `json:"api_credit_balance,omitempty"` // 当前剩余美金赠金，如 35.74
	APICreditTotal        int      `json:"api_credit_total,omitempty"`   // 月度总额度，如 10 / 40 / 100

	// 5. Google One 家庭组（含待接受邀请）
	FamilyRole    string `json:"family_role,omitempty"`    // "" | "none" | "manager" | "member"
	FamilyMembers int    `json:"family_members,omitempty"` // 已加入人数（含管理员，1–6）
	FamilyPending int    `json:"family_pending,omitempty"` // 已发出待接受邀请数（0–5）

	// 网页会话同步状态（总状态与敏感账单页二次验证状态解耦）
	WebStatus   string `json:"web_status,omitempty"`   // "" | "ok" | "needs_login" | "account_mismatch" | "error"
	BillingAuth string `json:"billing_auth,omitempty"` // "" | "ok" | "needs_reauth"
	WebError    string `json:"web_error,omitempty"`
}

func (p AccountPerks) isEmpty() bool {
	return p.TierOverride == "" &&
		p.WebTier == "" &&
		p.BillingState == "" &&
		p.RenewalDate == "" &&
		p.BillingSource == "" &&
		!p.BillingManual &&
		p.FlowCredits == nil &&
		p.FlowNextGrantAt == "" &&
		p.ColabCU == nil &&
		len(p.ColabGPUs) == 0 &&
		p.ColabObservedAt == "" &&
		p.ColabNoteDate == "" &&
		p.APICreditClaimedMonth == "" &&
		p.APICreditBalance == nil &&
		p.APICreditTotal == 0 &&
		p.FamilyRole == "" &&
		p.FamilyMembers == 0 &&
		p.FamilyPending == 0 &&
		p.WebStatus == "" &&
		p.BillingAuth == "" &&
		p.WebError == ""
}

// PerksPatch 支持字段级原子局部更新，未传的指针字段保持原值不变。
type PerksPatch struct {
	TierOverride          *string  `json:"tier_override,omitempty"`
	BillingState          *string  `json:"billing_state,omitempty"`
	RenewalDate           *string  `json:"renewal_date,omitempty"`
	BillingManual         *bool    `json:"billing_manual,omitempty"`
	FlowCredits           *int     `json:"flow_credits,omitempty"`
	ClearFlowCredits      bool     `json:"clear_flow_credits,omitempty"`
	FlowNextGrantAt       *string  `json:"flow_next_grant_at,omitempty"`
	ColabCU               *float64 `json:"colab_cu,omitempty"`
	ClearColabCU          bool     `json:"clear_colab_cu,omitempty"`
	ColabNoteDate         *string  `json:"colab_note_date,omitempty"`
	APICreditClaimedMonth *string  `json:"api_credit_claimed_month,omitempty"`
	FamilyRole            *string  `json:"family_role,omitempty"`
	FamilyMembers         *int     `json:"family_members,omitempty"`
	FamilyPending         *int     `json:"family_pending,omitempty"`
}

var (
	validTierOverrides = map[string]bool{
		"": true, "FREE": true, "PRO": true, "ULTRA": true, "ULTRA_5X": true, "ULTRA_20X": true,
	}
	validBillingStates = map[string]bool{
		"": true, "auto_renew": true, "cancelled": true, "expired": true,
	}
	validFamilyRoles = map[string]bool{
		"": true, "none": true, "manager": true, "member": true,
	}
)

func applyPerksPatch(p *AccountPerks, patch PerksPatch) error {
	if patch.TierOverride != nil {
		v := strings.ToUpper(strings.TrimSpace(*patch.TierOverride))
		if !validTierOverrides[v] {
			return errors.New("会员档位只能是 FREE / PRO / ULTRA / ULTRA_5X / ULTRA_20X")
		}
		p.TierOverride = v
	}

	billingTouched := false
	if patch.BillingState != nil {
		v := strings.ToLower(strings.TrimSpace(*patch.BillingState))
		if !validBillingStates[v] {
			return errors.New("续费状态只能是 auto_renew / cancelled / expired")
		}
		p.BillingState = v
		billingTouched = true
	}
	if patch.RenewalDate != nil {
		v := strings.TrimSpace(*patch.RenewalDate)
		if v != "" {
			if _, err := time.Parse(dateLayout, v); err != nil {
				return errors.New("扣费/到期日格式应为 YYYY-MM-DD")
			}
		}
		p.RenewalDate = v
		billingTouched = true
	}
	if patch.BillingManual != nil {
		p.BillingManual = *patch.BillingManual
	} else if billingTouched {
		p.BillingManual = p.BillingState != "" || p.RenewalDate != ""
	}

	if patch.ClearFlowCredits {
		p.FlowCredits = nil
	} else if patch.FlowCredits != nil {
		if *patch.FlowCredits < 0 {
			p.FlowCredits = nil
		} else {
			v := *patch.FlowCredits
			p.FlowCredits = &v
		}
	}
	if patch.FlowNextGrantAt != nil {
		v := strings.TrimSpace(*patch.FlowNextGrantAt)
		if len([]rune(v)) > 64 {
			return errors.New("下次积分到账时间太长")
		}
		p.FlowNextGrantAt = v
	}

	if patch.ClearColabCU {
		p.ColabCU = nil
		p.ColabObservedAt = ""
	} else if patch.ColabCU != nil {
		v := *patch.ColabCU
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return errors.New("Colab 计算单元数值无效")
		}
		if v < 0 {
			p.ColabCU = nil
			p.ColabObservedAt = ""
		} else {
			rounded := math.Round(v*100) / 100
			p.ColabCU = &rounded
			if rounded > 0 && p.ColabObservedAt == "" {
				p.ColabObservedAt = today()
			} else if rounded == 0 {
				p.ColabObservedAt = ""
			}
		}
	}
	if patch.ColabNoteDate != nil {
		v := strings.TrimSpace(*patch.ColabNoteDate)
		if v != "" {
			if _, err := time.Parse(dateLayout, v); err != nil {
				return errors.New("Colab 过期备注日期格式应为 YYYY-MM-DD")
			}
		}
		p.ColabNoteDate = v
	}

	if patch.APICreditClaimedMonth != nil {
		v := strings.TrimSpace(*patch.APICreditClaimedMonth)
		if v != "" {
			if _, err := time.Parse(monthLayout, v); err != nil {
				return errors.New("赠金领取月份格式应为 YYYY-MM")
			}
		}
		p.APICreditClaimedMonth = v
	}

	if patch.FamilyRole != nil {
		v := strings.ToLower(strings.TrimSpace(*patch.FamilyRole))
		if !validFamilyRoles[v] {
			return errors.New("家庭组角色只能是 none / manager / member")
		}
		p.FamilyRole = v
		if v == "" || v == "none" {
			p.FamilyMembers = 0
			p.FamilyPending = 0
		}
	}
	if patch.FamilyMembers != nil {
		if *patch.FamilyMembers < 0 || *patch.FamilyMembers > 6 {
			return errors.New("家庭组成员数应在 0–6 之间")
		}
		p.FamilyMembers = *patch.FamilyMembers
	}
	if patch.FamilyPending != nil {
		if *patch.FamilyPending < 0 || *patch.FamilyPending > 5 {
			return errors.New("待接受邀请数应在 0–5 之间")
		}
		p.FamilyPending = *patch.FamilyPending
	}
	if p.FamilyMembers+p.FamilyPending > 6 {
		return errors.New("家庭组已加入与待接受邀请总数不能超过 6 人")
	}
	return nil
}

// UpdatePerks 在互斥锁与数据库事务内完成「读取最新 perks_json → 字段合并 → 写回」，防止并发覆盖。
func (s *Store) UpdatePerks(id int64, fn func(*AccountPerks) (touchSyncAt bool, err error)) (Account, error) {
	s.perksMu.Lock()
	defer s.perksMu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return Account{}, err
	}
	defer tx.Rollback()

	var raw string
	var perksAt int64
	if err := tx.QueryRow(`SELECT perks_json, perks_at FROM accounts WHERE id = ?`, id).Scan(&raw, &perksAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Account{}, ErrNotFound
		}
		return Account{}, err
	}

	var p AccountPerks
	if raw != "" {
		_ = json.Unmarshal([]byte(raw), &p)
	}
	touch, err := fn(&p)
	if err != nil {
		return Account{}, err
	}

	nextRaw := ""
	if !p.isEmpty() {
		b, err := json.Marshal(p)
		if err != nil {
			return Account{}, err
		}
		nextRaw = string(b)
	}
	if touch {
		perksAt = time.Now().Unix()
	}

	if _, err := tx.Exec(`UPDATE accounts SET perks_json = ?, perks_at = ? WHERE id = ?`, nextRaw, perksAt, id); err != nil {
		return Account{}, err
	}
	if err := tx.Commit(); err != nil {
		return Account{}, err
	}
	return s.GetAccount(id)
}

func (a *App) patchAccountPerks(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	var patch PerksPatch
	if err := readJSON(w, r, &patch); err != nil {
		writeErr(w, err)
		return
	}
	saved, err := a.store.UpdatePerks(id, func(p *AccountPerks) (bool, error) {
		return false, applyPerksPatch(p, patch)
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, a.view(saved, today()))
}
