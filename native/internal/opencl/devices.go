//go:build !windows

package opencl

import (
	"fmt"
	"io"
	"runtime"
)

func ListDevices(w io.Writer) error {
	fmt.Fprintf(w, "OpenCL device discovery is implemented for Windows in this dev branch.\n")
	fmt.Fprintf(w, "OS: %s ARCH: %s\n", runtime.GOOS, runtime.GOARCH)
	fmt.Fprintf(w, "This build ships the CPU backend plus vendored OpenCL kernel sources.\n")
	fmt.Fprintf(w, "Target runtime path: Windows NVIDIA OpenCL first, then macOS Apple Silicon.\n")
	return nil
}
