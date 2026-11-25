package main

// 2FA（TOTP，RFC 6238）：Google 身份验证器使用 HMAC-SHA1、6 位、30 秒一换。

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

const (
	totpPeriod = 30
	totpDigits = 6
)

var base32NoPad = base32.StdEncoding.WithPadding(base32.NoPadding)

// parseTotpSecret 接受 Base32 密钥（可带空格）或 otpauth:// 链接，返回规范化的 Base32 密钥。
func parseTotpSecret(in string) (string, error) {
	in = strings.TrimSpace(in)
	if strings.HasPrefix(strings.ToLower(in), "otpauth://") {
		u, err := url.Parse(in)
		if err != nil || !strings.EqualFold(u.Host, "totp") {
			return "", errors.New("2FA 链接格式不对，应为 otpauth://totp/...")
		}
		q := u.Query()
		if alg := q.Get("algorithm"); alg != "" && !strings.EqualFold(alg, "SHA1") {
			return "", fmt.Errorf("暂不支持 %s 算法的 2FA，只支持 SHA1", alg)
		}
		if d := q.Get("digits"); d != "" && d != "6" {
			return "", fmt.Errorf("暂不支持 %s 位验证码的 2FA，只支持 6 位", d)
		}
		if p := q.Get("period"); p != "" && p != "30" {
			return "", fmt.Errorf("暂不支持 %s 秒刷新的 2FA，只支持 30 秒", p)
		}
		in = q.Get("secret")
	}
	s := strings.ToUpper(strings.NewReplacer(" ", "", "-", "", "=", "").Replace(in))
	if s == "" {
		return "", errors.New("2FA 密钥是空的")
	}
	if _, err := base32NoPad.DecodeString(s); err != nil {
		return "", errors.New("2FA 密钥不是有效的 Base32（只含 A-Z 和 2-7）")
	}
	return s, nil
}

// totpCode 计算时刻 t 的验证码。
func totpCode(secret string, t time.Time) (string, error) {
	key, err := base32NoPad.DecodeString(secret)
	if err != nil {
		return "", err
	}
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(t.Unix()/totpPeriod))
	mac := hmac.New(sha1.New, key)
	mac.Write(msg[:])
	sum := mac.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	v := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	return fmt.Sprintf("%0*d", totpDigits, v%1_000_000), nil
}
