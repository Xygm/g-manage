package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestReadServiceLogDelta(t *testing.T) {
	path := filepath.Join(t.TempDir(), "language_server.log")
	if err := os.WriteFile(path, []byte("old\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cursor := newServiceLogCursor(path)

	if err := os.WriteFile(path, []byte("old\nnew\npart"), 0o600); err != nil {
		t.Fatal(err)
	}
	lines, _, err := readServiceLogDelta(path, cursor)
	if err != nil || !reflect.DeepEqual(lines, []string{"new"}) {
		t.Fatalf("first delta = %q, %v", lines, err)
	}

	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString("ial\nnext\n"); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	lines, _, err = readServiceLogDelta(path, cursor)
	if err != nil || !reflect.DeepEqual(lines, []string{"partial", "next"}) {
		t.Fatalf("continued delta = %q, %v", lines, err)
	}

	if err := os.WriteFile(path, []byte("x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	lines, _, err = readServiceLogDelta(path, cursor)
	if err != nil || !reflect.DeepEqual(lines, []string{"x"}) {
		t.Fatalf("truncated delta = %q, %v", lines, err)
	}
}

func TestMarkServiceLogDisabledUsesCurrentClientAccount(t *testing.T) {
	root := t.TempDir()
	t.Setenv("APPDATA", root)
	store, err := OpenStore(filepath.Join(root, "gam.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()

	acc := Account{Email: "log-user@gmail.com", LoginDate: today(), RiskDays: 7, RefreshToken: "rt-log-user"}
	if err := acc.normalize(); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateAccount(&acc); err != nil {
		t.Fatal(err)
	}

	statePath := filepath.Join(root, "Antigravity", "User", "globalStorage", "state.vscdb")
	if err := os.MkdirAll(filepath.Dir(statePath), 0o700); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", statePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	creds := agyCreds{Email: acc.Email, RefreshToken: acc.RefreshToken, IDToken: fakeIDToken(acc.Email), Expiry: time.Now().Add(time.Hour)}
	if err := injectStateDB(statePath, creds); err != nil {
		t.Fatal(err)
	}

	app := &App{store: store, dataDir: root}
	future := time.Now().Add(time.Hour)
	if err := store.SetSwitchedAt(acc.ID, future.Unix()); err != nil {
		t.Fatal(err)
	}
	// 切号前的日志不能标到新账号。
	app.markServiceLogDisabled(targetClassic, time.Now())
	got, err := store.GetAccount(acc.ID)
	if err != nil || got.ServiceDisabled {
		t.Fatalf("old log marked current account: %+v, %v", got, err)
	}

	if err := store.SetSwitchedAt(acc.ID, time.Now().Add(-time.Hour).Unix()); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(root, "Antigravity", "logs", "language_server.log")
	if err := os.MkdirAll(filepath.Dir(logPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(logPath, []byte("boot\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	paths := serviceLogPaths()
	cursors := map[string]*serviceLogCursor{logPath: newServiceLogCursor(logPath)}
	logLine := "ERROR: transport error (PermissionDenied, HTTP 403): This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.\n"
	if err := os.WriteFile(logPath, []byte("boot\n"+logLine), 0o600); err != nil {
		t.Fatal(err)
	}
	app.scanServiceLogs(paths, cursors)
	got, err = store.GetAccount(acc.ID)
	if err != nil || !got.ServiceDisabled {
		t.Fatalf("current log did not mark account: %+v, %v", got, err)
	}
}
