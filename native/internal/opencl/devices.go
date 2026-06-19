package opencl

import (
	"fmt"
	"io"
	"runtime"
)

func ListDevices(w io.Writer) error {
	fmt.Fprintf(w, "OpenCL device discovery placeholder\n")
	fmt.Fprintf(w, "OS: %s ARCH: %s\n", runtime.GOOS, runtime.GOARCH)
	fmt.Fprintf(w, "This release ships the CPU backend. OpenCL kernels/device enumeration are the next native-engine step.\n")
	fmt.Fprintf(w, "Target platforms: macOS Apple Silicon OpenCL/Metal path, Windows NVIDIA OpenCL/CUDA path.\n")
	return nil
}
