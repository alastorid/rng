# RNG

RNG is an OpenCL-first Bitcoin address research runner. It loads a balance/address dataset, filters targets if requested, spreads work across all OpenCL devices, and runs the GPU RNG search path with device-side Bloom filtering.

The normal entrypoint is the platform run script:

```sh
./run.sh 1btc
```

```powershell
.\run.ps1 1btc
```

The scripts can run offline if the dataset and binary are already present. When network access is available, they can fetch/update the dataset from the `data` branch and update the prebuilt binary from the rolling release.

## Quick Start

Search all loaded targets:

```sh
./run.sh
```

Search only targets with at least 1 BTC:

```sh
./run.sh 1btc
```

Use a different balance threshold:

```sh
./run.sh 10btc
```

Tune Bloom and island levels:

```sh
./run.sh 1btc bloom8 island6
```

Argument order does not matter:

```sh
./run.sh island6 bloom8 1btc
```

PowerShell accepts the same tokens:

```powershell
.\run.ps1 1btc bloom8 island6
```

## Script Parameters

### BTC Balance Filter

`1btc`, `10btc`, `0.5btc`, etc. filter dataset rows by balance during the multi-threaded load phase.

Default behavior is to search all targets. Passing `1btc` means only rows with balance greater than or equal to `100,000,000` satoshis are loaded.

Equivalent environment variable:

```sh
RNG_MIN_BALANCE=1btc ./run.sh
```

### Bloom Level

`bloom0` through `bloom9` control the GPU Bloom filter size. The size scales with the number of loaded targets rather than being a fixed RAM amount.

Higher Bloom levels:
- use more VRAM
- reduce false positives
- reduce CPU follow-up work

Lower Bloom levels:
- use less VRAM
- increase false positives
- may slow the run if FP/s becomes high

Default: `bloom8`.

The status line reports false positives as `FP total/rate`, for example:

```text
FP 123/4.5s
```

Equivalent environment variable:

```sh
RNG_BLOOM_LEVEL=8 ./run.sh
```

### Island Level

`island0` through `island9` control how many sequential steps are walked from each random island base.

Higher island levels:
- reduce random-base regeneration overhead
- usually improve throughput
- make each random base cover a larger local neighborhood

Lower island levels:
- refresh random bases more often
- scatter work more aggressively
- cost more overhead

Default: `island4`, which is `65,536` steps. `island0` is the old `4,096` step size; each level doubles from there.

Equivalent environment variable:

```sh
RNG_ISLAND_LEVEL=6 ./run.sh
```

## Recommended Runs

Balanced default:

```sh
./run.sh 1btc
```

Try lower overhead:

```sh
./run.sh 1btc bloom8 island6
```

Try lower VRAM:

```sh
./run.sh 1btc bloom7 island6
```

If FP/s rises noticeably, move Bloom back up.

## Runtime Notes

RNG uses all OpenCL devices by default. On a dual-GPU machine, both GPUs are used and the displayed key rate is the combined rate from the active workers.

If no OpenCL GPU is available, the OpenCL device discovery path can fall back to CPU OpenCL devices.

The target loader parses the dataset once, in parallel, then shares the parsed target list with all OpenCL workers. It supports Base58, Bech32, and Bech32m address forms used by the current test corpus.

The special parser test token `s-272edf45031dd498e7b3ae89e11ff21b` is intentionally skipped. Other invalid address values in the selected address column are fatal and include parser column context in the error message.

## Useful Environment Variables

```sh
RNG_BACKEND=opencl
RNG_RELEASE_TAG=bitcrack-latest
RNG_KEYSPACE=START:END
RNG_DEVICE=0
RNG_BLOCKS=32
RNG_THREADS=256
RNG_POINTS=256
RNG_BIN=/path/to/local/clBitCrack
RNG_TARGETS_FILE=/path/to/targets-or-dump.tsv
RNG_MIN_BALANCE=1btc
RNG_BLOOM_LEVEL=8
RNG_ISLAND_LEVEL=4
```

## Building

Linux OpenCL build:

```sh
make BUILD_OPENCL=1 BUILD_CUDA=0
```

Windows builds are produced by the Visual Studio solution and the release workflow.

CUDA source is still present, but current RNG tuning work is OpenCL-first. The OpenCL path contains the current RNG island mode, all-device runner, Bloom levels, result batching, and target-loader updates.

## Output

Typical status line:

```text
Tesla M40 24GB   3030 / 24506MB | 56533653 targets 7.07 MKey/s (279,445,504 total) FP 123/4.5s [00:24:41]
```

Fields:
- device name
- used/total device memory
- loaded target count
- combined key rate
- total keys attempted
- false positive count/rate
- elapsed time
