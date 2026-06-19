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

## Run

Download the full real address balance dump:

```bash
curl -fL https://gz.blockchair.com/bitcoin/addresses/blockchair_bitcoin_addresses_latest.tsv.gz -o ../data/blockchair_bitcoin_addresses_latest.tsv.gz
```

Run:

```bash
./rng-native --address-dump ../data/blockchair_bitcoin_addresses_latest.tsv.gz --continuous --delay-ms 0
```

For seed-file testing only:

```bash
./rng-native --address-dump ../data/real-address-balances.csv --samples 10 --allow-small-dump
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
