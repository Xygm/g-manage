package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	wsGUID       = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
	maxCDPFrame  = 32 << 20 // 单条 CDP 消息最大允许 32MB，防异常内存膨胀
)

// readDevToolsEndpoint 读取 <userDataDir>/DevToolsActivePort，只允许连接本地回环上的 /devtools/browser/ 端点。
func readDevToolsEndpoint(userDataDir string) (addr, wsPath string, err error) {
	raw, err := os.ReadFile(filepath.Join(userDataDir, "DevToolsActivePort"))
	if err != nil {
		return "", "", err
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) < 2 {
		return "", "", errors.New("DevToolsActivePort 格式不完整")
	}
	port, err := strconv.Atoi(strings.TrimSpace(lines[0]))
	if err != nil || port <= 0 || port > 65535 {
		return "", "", errors.New("DevToolsActivePort 端口无效")
	}
	p := strings.TrimSpace(lines[1])
	if !strings.HasPrefix(p, "/devtools/browser/") {
		return "", "", errors.New("DevToolsActivePort 路径不合法")
	}
	return "127.0.0.1:" + strconv.Itoa(port), p, nil
}

// wsConn 是仅面向本机 127.0.0.1 CDP 的零外部依赖 RFC 6455 客户端：
// 保留 HTTP Upgrade 的 bufio.Reader、对客户端发送帧强制 4 字节随机掩码、支持 FIN=0 多分片重组与 Ping/Pong。
type wsConn struct {
	conn   net.Conn
	br     *bufio.Reader
	writeM sync.Mutex
}

func dialLocalWS(ctx context.Context, addr, path string) (*wsConn, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil || (host != "127.0.0.1" && host != "localhost") {
		return nil, errors.New("仅允许连接本机回环调试端口")
	}
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	} else {
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	}

	var keyBytes [16]byte
	if _, err := rand.Read(keyBytes[:]); err != nil {
		conn.Close()
		return nil, err
	}
	secKey := base64.StdEncoding.EncodeToString(keyBytes[:])

	// 不带 Origin 头：Chrome DevToolsHttpHandler 允许本地原生无 Origin 客户端，无需开启危险的 --remote-allow-origins=*。
	reqStr := fmt.Sprintf(
		"GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n",
		path, addr, secKey,
	)
	if _, err := io.WriteString(conn, reqStr); err != nil {
		conn.Close()
		return nil, err
	}

	br := bufio.NewReaderSize(conn, 64<<10)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodGet})
	if err != nil {
		conn.Close()
		return nil, err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		conn.Close()
		return nil, fmt.Errorf("CDP WebSocket 握手被拒绝：%s", resp.Status)
	}
	sum := sha1.Sum([]byte(secKey + wsGUID))
	wantAccept := base64.StdEncoding.EncodeToString(sum[:])
	if resp.Header.Get("Sec-WebSocket-Accept") != wantAccept {
		conn.Close()
		return nil, errors.New("CDP WebSocket 握手校验失败")
	}
	_ = conn.SetDeadline(time.Time{})
	return &wsConn{conn: conn, br: br}, nil
}

func (w *wsConn) Close() error { return w.conn.Close() }

func (w *wsConn) writeFrame(opcode byte, payload []byte) error {
	w.writeM.Lock()
	defer w.writeM.Unlock()

	var hdr [14]byte
	hdr[0] = 0x80 | (opcode & 0x0f) // FIN=1
	n := len(payload)
	pos := 2
	switch {
	case n <= 125:
		hdr[1] = 0x80 | byte(n) // MASK=1
	case n <= 65535:
		hdr[1] = 0x80 | 126
		binary.BigEndian.PutUint16(hdr[2:4], uint16(n))
		pos = 4
	default:
		hdr[1] = 0x80 | 127
		binary.BigEndian.PutUint64(hdr[2:10], uint64(n))
		pos = 10
	}
	var mask [4]byte
	if _, err := rand.Read(mask[:]); err != nil {
		return err
	}
	copy(hdr[pos:pos+4], mask[:])
	pos += 4

	buf := make([]byte, pos+n)
	copy(buf, hdr[:pos])
	for i := 0; i < n; i++ {
		buf[pos+i] = payload[i] ^ mask[i&3]
	}
	_ = w.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_, err := w.conn.Write(buf)
	_ = w.conn.SetWriteDeadline(time.Time{})
	return err
}

func (w *wsConn) readMessage() ([]byte, error) {
	var msg []byte
	expectCont := false
	for {
		var h [2]byte
		if _, err := io.ReadFull(w.br, h[:]); err != nil {
			return nil, err
		}
		fin := (h[0] & 0x80) != 0
		opcode := h[0] & 0x0f
		masked := (h[1] & 0x80) != 0
		length := int64(h[1] & 0x7f)

		switch length {
		case 126:
			var ext [2]byte
			if _, err := io.ReadFull(w.br, ext[:]); err != nil {
				return nil, err
			}
			length = int64(binary.BigEndian.Uint16(ext[:]))
		case 127:
			var ext [8]byte
			if _, err := io.ReadFull(w.br, ext[:]); err != nil {
				return nil, err
			}
			u := binary.BigEndian.Uint64(ext[:])
			if u > maxCDPFrame {
				return nil, errors.New("CDP 消息超过大小上限")
			}
			length = int64(u)
		}
		if length < 0 || int64(len(msg))+length > maxCDPFrame {
			return nil, errors.New("CDP 消息累计大小超限")
		}

		var mask [4]byte
		if masked {
			if _, err := io.ReadFull(w.br, mask[:]); err != nil {
				return nil, err
			}
		}
		chunk := make([]byte, length)
		if length > 0 {
			if _, err := io.ReadFull(w.br, chunk); err != nil {
				return nil, err
			}
			if masked {
				for i := range chunk {
					chunk[i] ^= mask[i&3]
				}
			}
		}

		switch opcode {
		case 0x8: // Close
			return nil, io.EOF
		case 0x9: // Ping → 回 Pong（可能穿插在分片帧之间）
			_ = w.writeFrame(0xA, chunk)
			continue
		case 0xA: // Pong
			continue
		case 0x1, 0x2: // Text / Binary 首帧
			if expectCont {
				return nil, errors.New("WebSocket 分片未结束时收到新首帧")
			}
			msg = append(msg[:0], chunk...)
			if fin {
				return msg, nil
			}
			expectCont = true
		case 0x0: // Continuation
			if !expectCont {
				return nil, errors.New("收到意外的 WebSocket 分片帧")
			}
			msg = append(msg, chunk...)
			if fin {
				return msg, nil
			}
		}
	}
}

type cdpEvent struct {
	SessionID string          `json:"sessionId"`
	Method    string          `json:"method"`
	Params    json.RawMessage `json:"params"`
}

type cdpWire struct {
	ID        int64           `json:"id"`
	SessionID string          `json:"sessionId,omitempty"`
	Method    string          `json:"method,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type cdpReply struct {
	result json.RawMessage
	err    error
}

type cdpClient struct {
	ws     *wsConn
	nextID atomic.Int64

	mu        sync.Mutex
	closed    bool
	done      chan struct{}
	pending   map[int64]chan cdpReply
	listeners map[int64]func(cdpEvent)
	nextSub   int64
}

func dialCDP(ctx context.Context, addr, path string) (*cdpClient, error) {
	ws, err := dialLocalWS(ctx, addr, path)
	if err != nil {
		return nil, err
	}
	c := &cdpClient{
		ws:        ws,
		done:      make(chan struct{}),
		pending:   map[int64]chan cdpReply{},
		listeners: map[int64]func(cdpEvent){},
	}
	go c.readLoop()
	return c, nil
}

func dialCDPFromDir(ctx context.Context, userDataDir string) (*cdpClient, error) {
	if !chromeRunning(userDataDir) {
		return nil, errors.New("浏览器未在运行")
	}
	addr, path, err := readDevToolsEndpoint(userDataDir)
	if err != nil {
		return nil, err
	}
	c, err := dialCDP(ctx, addr, path)
	if err != nil {
		return nil, err
	}
	// 验证确系存活的 Chrome DevTools 实例，排除残留端口被其它服务复用的情况。
	var ver struct {
		Product   string `json:"product"`
		UserAgent string `json:"userAgent"`
	}
	checkCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := c.call(checkCtx, "", "Browser.getVersion", nil, &ver); err != nil || ver.Product == "" {
		c.Close()
		return nil, errors.New("调试端口握手校验未通过")
	}
	return c, nil
}

func (c *cdpClient) Done() <-chan struct{} { return c.done }

func (c *cdpClient) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	for id, ch := range c.pending {
		ch <- cdpReply{err: errors.New("CDP 连接已关闭")}
		delete(c.pending, id)
	}
	c.mu.Unlock()
	return c.ws.Close()
}

func (c *cdpClient) subscribe(fn func(cdpEvent)) func() {
	c.mu.Lock()
	c.nextSub++
	id := c.nextSub
	c.listeners[id] = fn
	c.mu.Unlock()
	return func() {
		c.mu.Lock()
		delete(c.listeners, id)
		c.mu.Unlock()
	}
}

func (c *cdpClient) readLoop() {
	defer func() {
		_ = c.Close()
		close(c.done)
	}()
	for {
		raw, err := c.ws.readMessage()
		if err != nil {
			return
		}
		var m cdpWire
		if json.Unmarshal(raw, &m) != nil {
			continue
		}
		if m.ID != 0 {
			c.mu.Lock()
			ch, ok := c.pending[m.ID]
			if ok {
				delete(c.pending, m.ID)
			}
			c.mu.Unlock()
			if ok {
				if m.Error != nil {
					ch <- cdpReply{err: fmt.Errorf("CDP %d: %s", m.Error.Code, m.Error.Message)}
				} else {
					ch <- cdpReply{result: m.Result}
				}
			}
			continue
		}
		if m.Method != "" {
			c.mu.Lock()
			subs := make([]func(cdpEvent), 0, len(c.listeners))
			for _, fn := range c.listeners {
				subs = append(subs, fn)
			}
			c.mu.Unlock()
			ev := cdpEvent{SessionID: m.SessionID, Method: m.Method, Params: m.Params}
			for _, fn := range subs {
				fn(ev)
			}
		}
	}
}

func (c *cdpClient) call(ctx context.Context, sessionID, method string, params any, out any) error {
	id := c.nextID.Add(1)
	req := map[string]any{"id": id, "method": method}
	if sessionID != "" {
		req["sessionId"] = sessionID
	}
	if params != nil {
		req["params"] = params
	}
	payload, err := json.Marshal(req)
	if err != nil {
		return err
	}

	ch := make(chan cdpReply, 1)
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return errors.New("CDP 连接已关闭")
	}
	c.pending[id] = ch
	c.mu.Unlock()

	if err := c.ws.writeFrame(0x1, payload); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return err
	}

	select {
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return ctx.Err()
	case rep := <-ch:
		if rep.err != nil {
			return rep.err
		}
		if out != nil && len(rep.result) > 0 {
			return json.Unmarshal(rep.result, out)
		}
		return nil
	}
}
