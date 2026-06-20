# Native RNG Engine

This is the native engine track for macOS Apple Silicon and Windows NVIDIA systems.

Current runnable backend:

```text
Go CPU backend
```

Required next backend:

```text
OpenCL GPU backend
```

The CPU backend is intentionally first. It gives us a native correctness reference before GPU kernels are added.

Important: current `native-latest` binaries are CPU-only. `--backend opencl` is not GPU acceleration yet.

OpenCL kernel base has been vendored at:

```text
native/third_party/bitcrack-opencl
```

The next release must wire these kernels into the runtime before `--backend opencl` is enabled.

## Run

Fetch and extract the full real address balance dump via the repo-level run script:

```bash
../run.sh
```

Manual native run after extraction:

```bash
./rng-native --address-dump ../data/blockchair_bitcoin_addresses_latest_extracted/<dump>.tsv --continuous --delay-ms 0 --progress-interval 5s
```

For seed-file testing only:

```bash
./rng-native --address-dump ../data/real-address-balances.csv --samples 10 --allow-small-dump
```

Status output is time-based, not per-batch spam:

```text
status elapsed=5s sampled=145000 checked=290000 hits=0 rate=29000 keys/sec
```

CPU backend lookups use a read-only in-memory address map. Multiple CPU workers can query it concurrently without a per-lookup lock:

```bash
./rng-native --workers 8 --address-dump ../data/blockchair_bitcoin_addresses_latest_extracted/<dump>.tsv --continuous
```

## Device CLI

```bash
./rng-native --list-devices
```

The OpenCL flags are reserved now. GPU kernels are not enabled in this first native release.

## Release Targets

CI builds:

- `rng-native-darwin-arm64` for macOS Apple Silicon
- `rng-native-windows-amd64.exe` for Windows x64 / NVIDIA systems
