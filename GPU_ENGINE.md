# Cross-Platform GPU Engine Plan

Yes, this POC can be rewritten as a native cross-platform engine similar in shape to hashcat.

The right architecture is:

```text
CPU controller
  -> OS CSPRNG seed batches
  -> GPU kernel derives public keys / address hashes
  -> CPU receives candidate addresses
  -> local real address dump lookup
  -> append-only evidence log
```

## Recommended Language

Use **Go** for the controller and **OpenCL C** for GPU kernels.

Why Go:

- Single static binaries are easy on macOS, Linux, and Windows.
- Good file streaming and concurrency.
- Easier operational tooling than pure C.
- Can call OpenCL through CGO bindings.

Why not pure Go only:

- Go does not run on GPU by itself.
- The secp256k1 and hash kernels need OpenCL/CUDA/Metal/Vulkan/WebGPU style compute.

Why not pure C only:

- Fast and possible, but more fragile for CLI, logging, file parsing, and cross-platform packaging.

## GPU Backend Choice

Start with **OpenCL**:

- Cross-platform: AMD, Intel, many NVIDIA setups, macOS legacy OpenCL.
- Similar deployment model to hashcat.
- Lets user choose platform/device.

Later optional backends:

- CUDA: NVIDIA-only, fastest path for NVIDIA.
- Metal: best native macOS path.
- Vulkan compute: modern cross-vendor option, more boilerplate.

## What GPU Accelerates

GPU is useful for:

- private key batch generation/expansion
- secp256k1 public key derivation
- SHA-256 + RIPEMD-160
- address hash / witness program candidate generation

GPU is **not** ideal for:

- checking a huge string address table directly
- writing evidence logs
- parsing compressed public dumps

So the GPU should return compact candidate keys:

```text
candidate:
  private_key
  compressed_public_key
  p2pkh_address_or_hash
  p2wpkh_address_or_hash
```

The CPU then checks these candidates against the local real funded-address dataset.

## Dataset Format For Native Engine

For the current Blockchair dump:

```text
address<TAB>balance_sats
```

Native engine should build an in-memory index at startup:

```text
HashMap[address_string] -> balance_sats
```

For larger and faster production use, build two indexes:

```text
P2PKH/P2WPKH hash160 index:
  20-byte key -> balance_sats/address

P2WSH/P2TR/script index:
  address string or script key -> balance_sats/address
```

The RNG private-key experiment only naturally produces P2PKH/P2WPKH from a single ECDSA key. It will not produce arbitrary P2WSH multisig scripts unless we define a script-generation experiment.

## CLI Shape

Target command:

```bash
rng-gpu \
  --address-dump data/blockchair_bitcoin_addresses_latest.tsv.gz \
  --backend opencl \
  --platform 0 \
  --device 0 \
  --batch-size 1048576 \
  --continuous \
  --proof-log logs/hits.jsonl
```

Device discovery:

```bash
rng-gpu --list-devices
```

Expected output:

```text
OpenCL platforms:
  [0] Apple
      [0] Apple M-series GPU
  [1] NVIDIA CUDA
      [0] NVIDIA RTX ...
```

## Proof Logging

Same evidence model as the Node POC:

```json
{
  "run_id": "...",
  "candidate_index": 123,
  "address": "...",
  "balance_sats": "100000000",
  "private_key_hex": "...",
  "wif_compressed": "...",
  "dataset_source": "blockchair_bitcoin_addresses_latest.tsv.gz",
  "dataset_sha256": "...",
  "gpu_backend": "opencl",
  "gpu_device": "..."
}
```

## Practical Performance Note

The bottleneck changes by implementation:

- Node POC: address derivation + JavaScript overhead.
- Go CPU engine: secp256k1 public key derivation.
- GPU engine: memory transfer, kernel occupancy, and address lookup.

For a serious GPU version, we should benchmark:

- keys/sec generated
- public keys/sec
- hash160/sec
- lookup/sec
- end-to-end samples/sec

## Minimal Build Plan

1. Keep the current Node POC as correctness reference.
2. Build a Go CPU engine first:
   - read Blockchair dump
   - generate CSPRNG private keys
   - derive P2PKH/P2WPKH
   - local lookup
   - proof logs
3. Add OpenCL device discovery.
4. Add OpenCL SHA-256/RIPEMD-160 kernels.
5. Add GPU secp256k1 scalar multiplication.
6. Compare GPU output against Node/Go CPU output for fixed test keys.
7. Enable continuous GPU runs.

Do not skip step 2. A CPU-native engine gives us deterministic correctness before adding GPU complexity.
