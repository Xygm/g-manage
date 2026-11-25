package main

// Antigravity 客户端本地凭据的数据格式（按本机实际文件核对过）：
//   - state.vscdb 里 antigravityUnifiedStateSync.* 的值：base64(Topic)，
//     Topic.field1 = 条目 { 1: 哨兵键, 2: Row { 1: base64(payload) } }，可有多条；
//   - oauthTokenInfoSentinelKey 的 payload 是 OAuthTokenInfo：
//     1 access_token、2 token_type、3 refresh_token、4 Timestamp{1 秒}、5 id_token、6 is_gcp_tos；
//   - Windows 凭据管理器 gemini:antigravity 与 ~/.gemini 下的凭据文件：agyCredential 的 JSON。

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

const (
	topicOAuthToken = "antigravityUnifiedStateSync.oauthToken"
	topicUserStatus = "antigravityUnifiedStateSync.userStatus"
	topicEnterprise = "antigravityUnifiedStateSync.enterprisePreferences"

	sentinelOAuth      = "oauthTokenInfoSentinelKey"
	sentinelUserStatus = "userStatusSentinelKey"
	sentinelProject    = "enterpriseGcpProjectId"
)

var errBadProto = errors.New("protobuf 数据格式不对")

// agyCreds 是写给 Antigravity 客户端的一份登录凭据。
type agyCreds struct {
	Email        string
	AccessToken  string
	RefreshToken string
	IDToken      string
	Expiry       time.Time
	GCP          bool   // refresh token 由企业 / GCP 版客户端签发
	Project      string // GCP 版需要的项目 ID
}

/* ---------- protobuf 线格式 ---------- */

func pbAppendVarint(b []byte, v uint64) []byte {
	for v >= 0x80 {
		b = append(b, byte(v)|0x80)
		v >>= 7
	}
	return append(b, byte(v))
}

func pbAppendBytes(b []byte, field int, data []byte) []byte {
	b = pbAppendVarint(b, uint64(field)<<3|2)
	b = pbAppendVarint(b, uint64(len(data)))
	return append(b, data...)
}

func pbAppendString(b []byte, field int, s string) []byte { return pbAppendBytes(b, field, []byte(s)) }

func pbAppendVarintField(b []byte, field int, v uint64) []byte {
	b = pbAppendVarint(b, uint64(field)<<3)
	return pbAppendVarint(b, v)
}

func pbReadVarint(b []byte, i int) (uint64, int, error) {
	var v uint64
	for shift := 0; shift < 64; shift += 7 {
		if i >= len(b) {
			return 0, 0, errBadProto
		}
		c := b[i]
		i++
		v |= uint64(c&0x7f) << shift
		if c < 0x80 {
			return v, i, nil
		}
	}
	return 0, 0, errBadProto
}

type pbField struct {
	num   int
	wire  int
	value uint64 // wire 0
	data  []byte // wire 2
	raw   []byte // 整个字段（含 tag），用于原样保留
}

func pbParse(b []byte) ([]pbField, error) {
	var out []pbField
	for i := 0; i < len(b); {
		start := i
		tag, next, err := pbReadVarint(b, i)
		if err != nil {
			return nil, err
		}
		i = next
		f := pbField{num: int(tag >> 3), wire: int(tag & 7)}
		switch f.wire {
		case 0:
			if f.value, i, err = pbReadVarint(b, i); err != nil {
				return nil, err
			}
		case 1:
			i += 8
		case 2:
			n, next, err := pbReadVarint(b, i)
			if err != nil || n > uint64(len(b)-next) {
				return nil, errBadProto
			}
			f.data = b[next : next+int(n)]
			i = next + int(n)
		case 5:
			i += 4
		default:
			return nil, errBadProto
		}
		if i > len(b) {
			return nil, errBadProto
		}
		f.raw = b[start:i]
		out = append(out, f)
	}
	return out, nil
}

// pbBytes 返回第一个编号为 num 的长度分隔字段。
func pbBytes(b []byte, num int) ([]byte, bool) {
	fields, err := pbParse(b)
	if err != nil {
		return nil, false
	}
	for _, f := range fields {
		if f.num == num && f.wire == 2 {
			return f.data, true
		}
	}
	return nil, false
}

/* ---------- 统一状态同步条目 ---------- */

func topicEntry(sentinel string, payload []byte) []byte {
	row := pbAppendString(nil, 1, base64.StdEncoding.EncodeToString(payload))
	entry := pbAppendString(nil, 1, sentinel)
	entry = pbAppendBytes(entry, 2, row)
	return pbAppendBytes(nil, 1, entry)
}

func entrySentinel(entry []byte) string {
	k, _ := pbBytes(entry, 1)
	return string(k)
}

// setTopicEntry 用新的 payload 替换 Topic 里同一哨兵键的条目，其它条目原样保留。
func setTopicEntry(topic []byte, sentinel string, payload []byte) ([]byte, error) {
	fields, err := pbParse(topic)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, len(topic)+len(payload)*2)
	for _, f := range fields {
		if f.num == 1 && f.wire == 2 && entrySentinel(f.data) == sentinel {
			continue
		}
		out = append(out, f.raw...)
	}
	return append(out, topicEntry(sentinel, payload)...), nil
}

// topicPayload 取出 Topic 里某个哨兵键对应的 payload。
func topicPayload(topic []byte, sentinel string) ([]byte, bool) {
	fields, err := pbParse(topic)
	if err != nil {
		return nil, false
	}
	for _, f := range fields {
		if f.num != 1 || f.wire != 2 || entrySentinel(f.data) != sentinel {
			continue
		}
		row, ok := pbBytes(f.data, 2)
		if !ok {
			return nil, false
		}
		encoded, ok := pbBytes(row, 1)
		if !ok {
			return nil, false
		}
		payload, err := base64.StdEncoding.DecodeString(string(encoded))
		if err != nil {
			return nil, false
		}
		return payload, true
	}
	return nil, false
}

func encodeOAuthTokenInfo(c agyCreds) []byte {
	b := pbAppendString(nil, 1, c.AccessToken)
	b = pbAppendString(b, 2, "Bearer")
	b = pbAppendString(b, 3, c.RefreshToken)
	b = pbAppendBytes(b, 4, pbAppendVarintField(nil, 1, uint64(c.Expiry.Unix())))
	if c.IDToken != "" {
		b = pbAppendString(b, 5, c.IDToken)
	}
	if c.GCP {
		b = pbAppendVarintField(b, 6, 1)
	}
	return b
}

// decodeOAuthTokenInfo 只取认账号要用的 refresh token 和 id_token。
func decodeOAuthTokenInfo(p []byte) (refreshToken, idToken string, err error) {
	fields, err := pbParse(p)
	if err != nil {
		return "", "", err
	}
	for _, f := range fields {
		switch {
		case f.num == 3 && f.wire == 2:
			refreshToken = string(f.data)
		case f.num == 5 && f.wire == 2:
			idToken = string(f.data)
		}
	}
	return refreshToken, idToken, nil
}

// userStatusPayload 是最小可用的 UserStatus：3 = 名字，7 = 邮箱；其余信息客户端登录后自己拉取。
func userStatusPayload(email string) []byte {
	return pbAppendString(pbAppendString(nil, 3, email), 7, email)
}

func userStatusEmail(p []byte) string {
	e, _ := pbBytes(p, 7)
	return string(e)
}

/* ---------- JSON 凭据 ---------- */

type agyToken struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	RefreshToken string `json:"refresh_token"`
	Expiry       string `json:"expiry"`
}

// agyCredential 是凭据管理器 gemini:antigravity 与 ~/.gemini/*oauth-token 文件的内容。
type agyCredential struct {
	Token      agyToken `json:"token"`
	AuthMethod string   `json:"auth_method"`
	IDToken    string   `json:"id_token,omitempty"`
}

func credentialJSON(c agyCreds) []byte {
	b, _ := json.Marshal(agyCredential{
		Token: agyToken{
			AccessToken:  c.AccessToken,
			TokenType:    "Bearer",
			RefreshToken: c.RefreshToken,
			Expiry:       c.Expiry.Format(time.RFC3339Nano),
		},
		AuthMethod: "consumer",
		IDToken:    c.IDToken,
	})
	return b
}

// parseCredential 从凭据 JSON 里取 refresh token 和邮箱（邮箱来自 id_token）。
func parseCredential(raw []byte) (refreshToken, email string, err error) {
	var c agyCredential
	if err := json.Unmarshal(raw, &c); err != nil {
		return "", "", err
	}
	return c.Token.RefreshToken, jwtEmail(c.IDToken), nil
}

// jwtEmail 读出 id_token 里的邮箱（只用于显示和匹配账号，不校验签名）。
func jwtEmail(idToken string) string {
	parts := strings.Split(idToken, ".")
	if len(parts) != 3 {
		return ""
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return ""
	}
	var claims struct {
		Email string `json:"email"`
	}
	if json.Unmarshal(raw, &claims) != nil {
		return ""
	}
	return strings.ToLower(claims.Email)
}
