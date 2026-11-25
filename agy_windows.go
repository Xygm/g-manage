//go:build windows

package main

import (
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	procCredReadW   = windows.NewLazySystemDLL("advapi32.dll").NewProc("CredReadW")
	procCredWriteW  = windows.NewLazySystemDLL("advapi32.dll").NewProc("CredWriteW")
	procCredFree    = windows.NewLazySystemDLL("advapi32.dll").NewProc("CredFree")
	errCredNotFound = errors.New("凭据管理器里没有这条凭据")
)

const (
	credTypeGeneric         = 1
	credPersistLocalMachine = 2
	createNoWindow          = 0x08000000
	detachedProcess         = 0x00000008
)

// credentialW 对应 Win32 CREDENTIALW。
type credentialW struct {
	Flags              uint32
	Type               uint32
	TargetName         *uint16
	Comment            *uint16
	LastWritten        windows.Filetime
	CredentialBlobSize uint32
	CredentialBlob     *byte
	Persist            uint32
	AttributeCount     uint32
	Attributes         uintptr
	TargetAlias        *uint16
	UserName           *uint16
}

// credRead 读凭据管理器里的普通凭据。
func credRead(targetName string) ([]byte, error) {
	target, _ := windows.UTF16PtrFromString(targetName)
	var cred *credentialW
	r, _, err := procCredReadW.Call(uintptr(unsafe.Pointer(target)), credTypeGeneric, 0, uintptr(unsafe.Pointer(&cred)))
	if r == 0 {
		if errors.Is(err, windows.ERROR_NOT_FOUND) {
			return nil, errCredNotFound
		}
		return nil, fmt.Errorf("读取凭据管理器失败：%w", err)
	}
	defer procCredFree.Call(uintptr(unsafe.Pointer(cred)))
	blob := unsafe.Slice(cred.CredentialBlob, cred.CredentialBlobSize)
	return append([]byte(nil), blob...), nil
}

// credWrite 写普通凭据（CredWrite 对同名凭据本身就是覆盖）。
func credWrite(targetName, userName string, blob []byte) error {
	if len(blob) == 0 {
		return errors.New("凭据内容为空")
	}
	target, _ := windows.UTF16PtrFromString(targetName)
	user, _ := windows.UTF16PtrFromString(userName)
	cred := credentialW{
		Type:               credTypeGeneric,
		TargetName:         target,
		CredentialBlobSize: uint32(len(blob)),
		CredentialBlob:     &blob[0],
		Persist:            credPersistLocalMachine,
		UserName:           user,
	}
	if r, _, err := procCredWriteW.Call(uintptr(unsafe.Pointer(&cred)), 0); r == 0 {
		return fmt.Errorf("写入凭据管理器失败：%w", err)
	}
	return nil
}

func listProcesses() ([]procInfo, error) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(snap)
	var out []procInfo
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	for err = windows.Process32First(snap, &entry); err == nil; err = windows.Process32Next(snap, &entry) {
		name := windows.UTF16ToString(entry.ExeFile[:])
		p := procInfo{pid: entry.ProcessID, ppid: entry.ParentProcessID}
		// 只查可能相关的进程的完整路径，避免对几百个进程逐个 OpenProcess。
		if lower := strings.ToLower(name); strings.Contains(lower, "antigravity") || strings.Contains(lower, "agy") {
			p.exe = processPath(entry.ProcessID)
		}
		out = append(out, p)
	}
	return out, nil
}

func processPath(pid uint32) string {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n := uint32(len(buf))
	if windows.QueryFullProcessImageName(h, 0, &buf[0], &n) != nil {
		return ""
	}
	return windows.UTF16ToString(buf[:n])
}

func processAlive(pid uint32) bool {
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, pid)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	ev, _ := windows.WaitForSingleObject(h, 0)
	return ev == uint32(windows.WAIT_TIMEOUT)
}

func taskkill(pids []uint32, force bool) {
	args := []string{"/T"}
	if force {
		args = append(args, "/F")
	}
	for _, pid := range pids {
		args = append(args, "/PID", strconv.FormatUint(uint64(pid), 10))
	}
	cmd := exec.Command("taskkill", args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	_ = cmd.Run() // 进程已退出时 taskkill 也会报错，以下面的存活检查为准
}

func waitExit(pids []uint32, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		alive := false
		for _, pid := range pids {
			if processAlive(pid) {
				alive = true
				break
			}
		}
		if !alive {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(300 * time.Millisecond)
	}
}

// closeProcessTrees 先正常关闭（给窗口发关闭消息，编辑器可借此提示保存），超时后强制结束整个进程树。
func closeProcessTrees(pids []uint32, graceful time.Duration) error {
	if len(pids) == 0 {
		return nil
	}
	taskkill(pids, false)
	if waitExit(pids, graceful) {
		return nil
	}
	taskkill(pids, true)
	if waitExit(pids, 10*time.Second) {
		return nil
	}
	return errors.New("进程没能结束，请手动关闭后重试")
}

func startProgram(exe string) error {
	cmd := exec.Command(exe)
	cmd.Dir = filepath.Dir(exe)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: detachedProcess | windows.CREATE_NEW_PROCESS_GROUP}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
