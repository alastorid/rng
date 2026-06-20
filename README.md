# Pure RNG Bitcoin Address Sampling POC

Native local POC for independent random trials:

```text
OS entropy -> private key -> public Bitcoin address -> local real address dump lookup -> evidence log
```

The main POC uses CI-built native binaries. No npm is required to run it.

## Dataset

The real lookup source is the split 7z archive stored in this repo's `data` branch:

```text
data/blockchair_bitcoin_addresses_latest/blockchair_bitcoin_addresses_latest.7z.001
...
data/blockchair_bitcoin_addresses_latest/blockchair_bitcoin_addresses_latest.7z.160
```

The scripts fetch that branch locally, extract the archive, and run against the extracted real address-balance TSV:

```text
data/blockchair_bitcoin_addresses_latest_extracted/<dump>.tsv
```

No third-party dataset host is used at run time.

## Run On macOS Apple Silicon

```bash
./run.sh
```

`run.sh` downloads:

- `rng-native-darwin-arm64` from the `native-latest` GitHub release
- the split dataset archive from the repo `data` branch, if it is not already extracted

Then it runs continuously with local lookup only.

If the GitHub repo is private, authenticate GitHub CLI first:

```bash
gh auth login --hostname github.com
```

## Run On Windows

From PowerShell:

```powershell
.\run.ps1
```

`run.ps1` downloads:

- `rng-native-windows-amd64.exe`
- the split dataset archive from the repo `data` branch, if it is not already extracted

Then it runs continuously with local lookup only.

If the GitHub repo is private, authenticate GitHub CLI first:

```powershell
gh auth login --hostname github.com
```

## Native Release Binaries

GitHub Actions builds and publishes:

- `rng-native-darwin-arm64` for macOS Apple Silicon
- `rng-native-windows-amd64.exe` for Windows x64

Release:

```text
https://github.com/alastorid/rng/releases/tag/native-latest
```

Manual macOS command:

```bash
./dist/rng-native-darwin-arm64 --address-dump data/blockchair_bitcoin_addresses_latest_extracted/<dump>.tsv --continuous --delay-ms 0 --progress-interval 5s
```

Manual Windows command:

```powershell
.\dist\rng-native-windows-amd64.exe --address-dump data\blockchair_bitcoin_addresses_latest_extracted\<dump>.tsv --continuous --delay-ms 0 --progress-interval 5s
```

## GPU Status

Current native release:

```text
CPU backend
```

Required next backend:

```text
OpenCL GPU backend
```

The current binary is not GPU accelerated yet. See [GPU_ENGINE.md](GPU_ENGINE.md).

The current CPU backend supports concurrent workers and time-based status:

```bash
./dist/rng-native-darwin-arm64 --workers 8 --progress-interval 5s --address-dump data/blockchair_bitcoin_addresses_latest_extracted/<dump>.tsv --continuous
```

## Seed Testing Only

The committed seed CSV has only a few real addresses and is not the full experiment dataset.

Use it only for tiny smoke tests:

```bash
./dist/rng-native-darwin-arm64 --address-dump data/real-address-balances.csv --samples 10 --allow-small-dump
```

Without `--allow-small-dump`, the native runner refuses small datasets.

## Legacy Node Tools

The old Node/npm scripts remain as reference and dataset utilities only. They are not the primary POC path anymore.

## Evidence

On a hit, the native runner writes JSONL proof records with:

- generated address
- address type
- balance
- dataset source and checksum
- compressed public key
- private key / WIF for the hit

Expected result under modern cryptographic assumptions: zero funded collisions.
