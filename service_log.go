package main

import (
	"bytes"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// serviceLogCursor 记录已经读到的位置；文件重启截断或替换时从头读新文件。
type serviceLogCursor struct {
	offset  int64
	modTime time.Time
	info    os.FileInfo
}

// readServiceLogDelta 只返回新增的完整行，半行留到下次写入后再读。
func readServiceLogDelta(path string, cursor *serviceLogCursor) ([]string, time.Time, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, time.Time{}, err
	}
	if cursor.info != nil && info.Size() == cursor.offset && info.ModTime().Equal(cursor.modTime) && os.SameFile(cursor.info, info) {
		return nil, info.ModTime(), nil
	}
	offset := cursor.offset
	if offset < 0 || info.Size() < offset || info.ModTime().Before(cursor.modTime) || (cursor.info != nil && !os.SameFile(cursor.info, info)) {
		offset = 0
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, time.Time{}, err
	}
	defer file.Close()
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return nil, time.Time{}, err
	}
	data, err := io.ReadAll(io.LimitReader(file, 4<<20))
	if err != nil {
		return nil, time.Time{}, err
	}
	complete := len(data)
	if complete > 0 && data[complete-1] != '\n' {
		if last := bytes.LastIndexByte(data, '\n'); last >= 0 {
			complete = last + 1
		} else {
			complete = 0
		}
	}
	cursor.offset = offset + int64(complete)
	cursor.modTime = info.ModTime()
	cursor.info = info
	if complete == 0 {
		return nil, info.ModTime(), nil
	}
	var lines []string
	for _, line := range strings.Split(string(data[:complete]), "\n") {
		if strings.TrimSpace(line) != "" {
			lines = append(lines, line)
		}
	}
	return lines, info.ModTime(), nil
}

func serviceLogPaths() map[clientTarget][]string {
	paths := make(map[clientTarget][]string)
	root := os.Getenv("APPDATA")
	if root == "" {
		return paths
	}
	for _, target := range []clientTarget{targetIDE, targetClassic} {
		for _, folder := range dataFolders(target) {
			paths[target] = append(paths[target], filepath.Join(root, folder, "logs", "language_server.log"))
		}
	}
	return paths
}

func newServiceLogCursor(path string) *serviceLogCursor {
	cursor := &serviceLogCursor{}
	if info, err := os.Stat(path); err == nil {
		// 启动时不把旧日志归到当前账号；之后新增或新会话重建的日志都会读取。
		cursor.offset = info.Size()
		cursor.modTime = info.ModTime()
		cursor.info = info
	}
	return cursor
}

func (a *App) markServiceLogDisabled(target clientTarget, modified time.Time) {
	statuses, err := a.clientStatuses()
	if err != nil {
		log.Printf("读取 %s 当前账号失败：%v", target.longName(), err)
		return
	}
	for _, status := range statuses {
		if status.Target != target || status.AccountID == 0 {
			continue
		}
		acc, err := a.store.GetAccount(status.AccountID)
		if err != nil {
			continue
		}
		// 日志写入可能稍有延迟；切号前产生的错误不能算到新账号头上。
		if acc.SwitchedAt > 0 && modified.Unix() < acc.SwitchedAt {
			continue
		}
		if err := a.store.SetServiceDisabled(acc.ID, ""); err != nil {
			log.Printf("保存 %s 的日志停用状态失败：%v", acc.Email, err)
			continue
		}
		log.Printf("从 %s 日志确认 %s 的 Antigravity 服务已停用", target.longName(), acc.Email)
	}
}

func (a *App) scanServiceLogs(paths map[clientTarget][]string, cursors map[string]*serviceLogCursor) {
	for target, candidates := range paths {
		for _, path := range candidates {
			lines, modified, err := readServiceLogDelta(path, cursors[path])
			if err != nil {
				continue
			}
			disabled := false
			for _, line := range lines {
				if _, hit := serviceDisabledText(line); hit {
					disabled = true
					break
				}
			}
			if disabled {
				a.markServiceLogDisabled(target, modified)
			}
		}
	}
}

// monitorServiceLogs 被动监听真实客户端错误，不发送测试消息，也不消耗账号额度。
func (a *App) monitorServiceLogs() {
	paths := serviceLogPaths()
	cursors := map[string]*serviceLogCursor{}
	for _, candidates := range paths {
		for _, path := range candidates {
			cursors[path] = newServiceLogCursor(path)
		}
	}
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		a.scanServiceLogs(paths, cursors)
	}
}
