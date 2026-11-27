package main

import (
	"testing"
	"time"
)

func TestParseRealGooglePayloads(t *testing.T) {
	// 1. Flow 真实线上包体（10,050 积分 + Unix 1797960385 到账时间）
	flowRaw := ")]}'\n\n141\n[[\"wrb.fr\",\"nzlxg\",\"[10050,8,9,3,null,10050,[1797960385]]\",null,null,null,\"generic\"],[\"di\",158],[\"af.httprm\",157,\"-6667184832881757922\",0]]\n25\n[[\"e\",4,null,null,177]]\n"
	credits, nextGrant, ok := parseFlowBatchExecute(flowRaw)
	if !ok || credits != 10050 || nextGrant == "" {
		t.Fatalf("parseFlowBatchExecute got ok=%v credits=%d nextGrant=%q", ok, credits, nextGrant)
	}

	// 2. Colab 真实线上 ccu-info 包体（1,000 CU + H100/A100 等 GPU）
	colabRaw := ")]}'\n[1000,0,0,[\"H100\",\"G4\",\"A100\",\"L4\",\"T4\"],null,null,[\"V6E1\",\"V5E1\"]]"
	cu, gpus, ok := parseColabCCUInfo(colabRaw)
	if !ok || cu != 1000 || len(gpus) != 5 || gpus[0] != "H100" {
		t.Fatalf("parseColabCCUInfo got ok=%v cu=%v gpus=%v", ok, cu, gpus)
	}

	// 3. Subscriptions 真实文本（Renews vs Expires）
	st, ymd, ok := parseSubscriptionsText("Managed by Google\nYouTube Premium\nFamily subscription\nRenews on Dec 22, 2026\n")
	if !ok || st != "auto_renew" || ymd != "2026-12-22" {
		t.Fatalf("parseSubscriptionsText renews got ok=%v st=%q ymd=%q", ok, st, ymd)
	}
	st2, ymd2, ok2 := parseSubscriptionsText("Google AI Pro\nExpires on Jan 5, 2027")
	if !ok2 || st2 != "cancelled" || ymd2 != "2027-01-05" {
		t.Fatalf("parseSubscriptionsText expires got ok=%v st=%q ymd=%q", ok2, st2, ymd2)
	}

	// 4. Developer Program 真实文本（$40 monthly -> ULTRA_5X, Remaining balance: $35.74）
	benefitsText := "November '26\n$40 monthly Gen AI & Cloud credits\nBilling account\nMy Billing Account\nRemaining balance: $35.74"
	tot, bal, month, tier := parseDeveloperBenefitsText(benefitsText, time.Date(2026, 11, 26, 12, 0, 0, 0, time.Local))
	if tot != 40 || bal == nil || *bal != 35.74 || month != "2026-11" || tier != "ULTRA_5X" {
		t.Fatalf("parseDeveloperBenefitsText got tot=%d bal=%v month=%q tier=%q", tot, bal, month, tier)
	}

	// 5. Google One Plans & Family 真实文本
	wt, src := parseOnePlansText(
		"Current plan\nGoogle AI Ultra\n20 TB\nTRY 1,989.99 / month\ngo to Apple Settings on your iPhone",
		`"Gemini app with usage limits that are 5x higher than the AI Pro plan"`,
	)
	if wt != "ULTRA" || src != "apple" {
		t.Fatalf("parseOnePlansText got tier=%q src=%q", wt, src)
	}

	// Pro 号的套餐页同样列出 Ultra（以及它「20x higher」的介绍），只能认「Current plan」所在的那张卡片。
	wt, _ = parseOnePlansText(
		"Google AI Pro\nCurrent plan\n2 TB\nJPY 2,900 / month\nGoogle AI Ultra\n30 TB\nUpgrade",
		`"usage limits that are 20x higher than the AI Pro plan"`,
	)
	if wt != "PRO" {
		t.Fatalf("parseOnePlansText on a Pro account got tier=%q", wt)
	}

	// 退订降级后存下的档位要跟着降，笼统的 ULTRA 不覆盖已细分的 20x。
	if got := observeWebTier("ULTRA_20X", "PRO"); got != "PRO" {
		t.Fatalf("observeWebTier downgrade got %q", got)
	}
	if got := observeWebTier("ULTRA_20X", "ULTRA"); got != "ULTRA_20X" {
		t.Fatalf("observeWebTier generic ultra got %q", got)
	}

	role, mem, pend, ft := parseFamilyDetailsText("Google AI Ultra plan\nYour family on Google\nYou can create a Family Group with up to 6 people\nGet started")
	if role != "none" || mem != 0 || pend != 0 || ft != "ULTRA" {
		t.Fatalf("parseFamilyDetailsText got role=%q mem=%d pend=%d tier=%q", role, mem, pend, ft)
	}
}
