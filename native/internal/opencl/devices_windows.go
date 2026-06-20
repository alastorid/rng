package opencl

import (
	"fmt"
	"io"
	"strings"
	"syscall"
	"unsafe"
)

const (
	clDeviceTypeAll       = 0xFFFFFFFF
	clPlatformName        = 0x0902
	clPlatformVendor      = 0x0903
	clPlatformVersion     = 0x0901
	clDeviceName          = 0x102B
	clDeviceVendor        = 0x102C
	clDeviceVersion       = 0x102F
	clDriverVersion       = 0x102D
	clDeviceType          = 0x1000
	clDeviceMaxCompute    = 0x1002
	clDeviceMaxClock      = 0x100C
	clDeviceGlobalMemSize = 0x101F
	clSuccess             = 0
)

type api struct {
	getPlatformIDs  *syscall.LazyProc
	getPlatformInfo *syscall.LazyProc
	getDeviceIDs    *syscall.LazyProc
	getDeviceInfo   *syscall.LazyProc
}

func ListDevices(w io.Writer) error {
	lib := syscall.NewLazyDLL("OpenCL.dll")
	a := api{
		getPlatformIDs:  lib.NewProc("clGetPlatformIDs"),
		getPlatformInfo: lib.NewProc("clGetPlatformInfo"),
		getDeviceIDs:    lib.NewProc("clGetDeviceIDs"),
		getDeviceInfo:   lib.NewProc("clGetDeviceInfo"),
	}
	if err := lib.Load(); err != nil {
		return fmt.Errorf("OpenCL.dll not found; install NVIDIA/AMD/Intel OpenCL runtime: %w", err)
	}

	var platformCount uint32
	if code := call(a.getPlatformIDs, 0, 0, ptr(&platformCount)); code != clSuccess {
		return fmt.Errorf("clGetPlatformIDs(count) failed: %s", status(code))
	}
	if platformCount == 0 {
		fmt.Fprintln(w, "No OpenCL platforms found.")
		return nil
	}

	platforms := make([]uintptr, platformCount)
	if code := call(a.getPlatformIDs, uintptr(platformCount), ptr(&platforms[0]), 0); code != clSuccess {
		return fmt.Errorf("clGetPlatformIDs(list) failed: %s", status(code))
	}

	fmt.Fprintf(w, "OpenCL platforms: %d\n", platformCount)
	for platformIndex, platform := range platforms {
		fmt.Fprintf(w, "\nPlatform %d\n", platformIndex)
		fmt.Fprintf(w, "  Name:    %s\n", platformString(a, platform, clPlatformName))
		fmt.Fprintf(w, "  Vendor:  %s\n", platformString(a, platform, clPlatformVendor))
		fmt.Fprintf(w, "  Version: %s\n", platformString(a, platform, clPlatformVersion))

		var deviceCount uint32
		code := call(a.getDeviceIDs, platform, clDeviceTypeAll, 0, 0, ptr(&deviceCount))
		if code != clSuccess {
			fmt.Fprintf(w, "  Devices: unavailable (%s)\n", status(code))
			continue
		}
		if deviceCount == 0 {
			fmt.Fprintln(w, "  Devices: 0")
			continue
		}

		devices := make([]uintptr, deviceCount)
		if code := call(a.getDeviceIDs, platform, clDeviceTypeAll, uintptr(deviceCount), ptr(&devices[0]), 0); code != clSuccess {
			fmt.Fprintf(w, "  Devices: unavailable (%s)\n", status(code))
			continue
		}

		fmt.Fprintf(w, "  Devices: %d\n", deviceCount)
		for deviceIndex, device := range devices {
			fmt.Fprintf(w, "    Device %d\n", deviceIndex)
			fmt.Fprintf(w, "      Name:           %s\n", deviceString(a, device, clDeviceName))
			fmt.Fprintf(w, "      Vendor:         %s\n", deviceString(a, device, clDeviceVendor))
			fmt.Fprintf(w, "      Device Version: %s\n", deviceString(a, device, clDeviceVersion))
			fmt.Fprintf(w, "      Driver Version: %s\n", deviceString(a, device, clDriverVersion))
			fmt.Fprintf(w, "      Type:           %s\n", deviceTypeName(deviceUint64(a, device, clDeviceType)))
			fmt.Fprintf(w, "      Compute Units:  %d\n", deviceUint32(a, device, clDeviceMaxCompute))
			fmt.Fprintf(w, "      Clock MHz:      %d\n", deviceUint32(a, device, clDeviceMaxClock))
			fmt.Fprintf(w, "      Global Memory:  %.2f GiB\n", float64(deviceUint64(a, device, clDeviceGlobalMemSize))/(1024*1024*1024))
		}
	}

	return nil
}

func call(proc *syscall.LazyProc, args ...uintptr) int32 {
	r1, _, _ := proc.Call(args...)
	return int32(r1)
}

func ptr[T any](v *T) uintptr {
	return uintptr(unsafe.Pointer(v))
}

func platformString(a api, platform uintptr, param uint32) string {
	return getString(a.getPlatformInfo, platform, param)
}

func deviceString(a api, device uintptr, param uint32) string {
	return getString(a.getDeviceInfo, device, param)
}

func getString(proc *syscall.LazyProc, id uintptr, param uint32) string {
	var size uintptr
	if code := call(proc, id, uintptr(param), 0, 0, ptr(&size)); code != clSuccess || size == 0 {
		return ""
	}
	buf := make([]byte, size)
	if code := call(proc, id, uintptr(param), size, ptr(&buf[0]), 0); code != clSuccess {
		return ""
	}
	return strings.TrimRight(string(buf), "\x00")
}

func deviceUint32(a api, device uintptr, param uint32) uint32 {
	var value uint32
	if code := call(a.getDeviceInfo, device, uintptr(param), unsafe.Sizeof(value), ptr(&value), 0); code != clSuccess {
		return 0
	}
	return value
}

func deviceUint64(a api, device uintptr, param uint32) uint64 {
	var value uint64
	if code := call(a.getDeviceInfo, device, uintptr(param), unsafe.Sizeof(value), ptr(&value), 0); code != clSuccess {
		return 0
	}
	return value
}

func deviceTypeName(value uint64) string {
	names := []string{}
	if value&1 != 0 {
		names = append(names, "default")
	}
	if value&2 != 0 {
		names = append(names, "CPU")
	}
	if value&4 != 0 {
		names = append(names, "GPU")
	}
	if value&8 != 0 {
		names = append(names, "accelerator")
	}
	if len(names) == 0 {
		return fmt.Sprintf("0x%x", value)
	}
	return strings.Join(names, ",")
}

func status(code int32) string {
	names := map[int32]string{
		0:   "CL_SUCCESS",
		-1:  "CL_DEVICE_NOT_FOUND",
		-2:  "CL_DEVICE_NOT_AVAILABLE",
		-30: "CL_INVALID_VALUE",
		-32: "CL_INVALID_PLATFORM",
		-33: "CL_INVALID_DEVICE",
		-1001: "CL_PLATFORM_NOT_FOUND_KHR",
	}
	if name, ok := names[code]; ok {
		return fmt.Sprintf("%s (%d)", name, code)
	}
	return fmt.Sprintf("OpenCL error %d", code)
}
