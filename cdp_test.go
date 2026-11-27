package main

import (
	"bufio"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

func writeServerFrame(w io.Writer, fin bool, opcode byte, payload []byte) error {
	var hdr [10]byte
	if fin {
		hdr[0] = 0x80 | opcode
	} else {
		hdr[0] = opcode
	}
	n := len(payload)
	pos := 2
	switch {
	case n <= 125:
		hdr[1] = byte(n)
	case n <= 65535:
		hdr[1] = 126
		binary.BigEndian.PutUint16(hdr[2:4], uint16(n))
		pos = 4
	default:
		hdr[1] = 127
		binary.BigEndian.PutUint64(hdr[2:10], uint64(n))
		pos = 10
	}
	if _, err := w.Write(hdr[:pos]); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

func readClientMaskedFrame(br *bufio.Reader) (opcode byte, payload []byte, err error) {
	var h [2]byte
	if _, err := io.ReadFull(br, h[:]); err != nil {
		return 0, nil, err
	}
	opcode = h[0] & 0x0f
	masked := (h[1] & 0x80) != 0
	if !masked {
		return 0, nil, io.ErrUnexpectedEOF
	}
	length := int(h[1] & 0x7f)
	if length == 126 {
		var ext [2]byte
		if _, err := io.ReadFull(br, ext[:]); err != nil {
			return 0, nil, err
		}
		length = int(binary.BigEndian.Uint16(ext[:]))
	}
	var mask [4]byte
	if _, err := io.ReadFull(br, mask[:]); err != nil {
		return 0, nil, err
	}
	payload = make([]byte, length)
	if _, err := io.ReadFull(br, payload); err != nil {
		return 0, nil, err
	}
	for i := range payload {
		payload[i] ^= mask[i&3]
	}
	return opcode, payload, nil
}

func TestCDPClientFragmentedFramesAndPingPong(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("sandbox disallow listen: %v", err)
	}
	defer ln.Close()

	pongReceived := make(chan string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		br := bufio.NewReader(conn)
		req, err := http.ReadRequest(br)
		if err != nil {
			return
		}
		sum := sha1.Sum([]byte(req.Header.Get("Sec-WebSocket-Key") + wsGUID))
		accept := base64.StdEncoding.EncodeToString(sum[:])
		_, _ = io.WriteString(conn, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+accept+"\r\n\r\n")

		// 读取客户端发来的 masked RPC 请求
		op, data, err := readClientMaskedFrame(br)
		if err != nil || op != 0x1 {
			return
		}
		var rpc struct {
			ID int64 `json:"id"`
		}
		_ = json.Unmarshal(data, &rpc)

		// 构造 >70KB 响应，拆成 3 个分片，并在中间穿插一帧 Ping
		bigText := strings.Repeat("x", 72000)
		respBytes, _ := json.Marshal(map[string]any{
			"id":     rpc.ID,
			"result": map[string]string{"body": bigText},
		})
		part1 := respBytes[:20000]
		part2 := respBytes[20000:55000]
		part3 := respBytes[55000:]

		_ = writeServerFrame(conn, false, 0x1, part1)
		_ = writeServerFrame(conn, true, 0x9, []byte("ping-check"))
		_ = writeServerFrame(conn, false, 0x0, part2)
		_ = writeServerFrame(conn, true, 0x0, part3)

		// 读取客户端自动回的 masked Pong
		op2, pongData, err := readClientMaskedFrame(br)
		if err == nil && op2 == 0xA {
			pongReceived <- string(pongData)
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cli, err := dialCDP(ctx, ln.Addr().String(), "/devtools/browser/test-uuid")
	if err != nil {
		t.Fatalf("dialCDP: %v", err)
	}
	defer cli.Close()

	var out struct {
		Body string `json:"body"`
	}
	if err := cli.call(ctx, "sess-1", "Network.getResponseBody", map[string]string{"requestId": "1"}, &out); err != nil {
		t.Fatalf("call: %v", err)
	}
	if len(out.Body) != 72000 {
		t.Fatalf("expected 72000 bytes body, got %d", len(out.Body))
	}
	select {
	case p := <-pongReceived:
		if p != "ping-check" {
			t.Fatalf("unexpected pong payload %q", p)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for masked pong")
	}
}
