//go:build !windows

package main

import "time"

// 非 Windows 只用于开发调试：读不到客户端，切号直接报不支持。

func credRead(string) ([]byte, error)        { return nil, errUnsupportedOS }
func credWrite(string, string, []byte) error { return errUnsupportedOS }
func listProcesses() ([]procInfo, error)     { return nil, nil }

func closeProcessTrees([]uint32, time.Duration) error { return errUnsupportedOS }
func startProgram(string) error                       { return errUnsupportedOS }
