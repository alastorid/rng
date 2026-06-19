# Local Bitcoin Live Address Dataset POC

Goal for this phase:

```text
Random hash160 -> local lookup -> exists? balance_sats?
```

This layer does not search private keys and does not optimize collision attempts. It only defines a fixed local dataset and a fast lookup path.

## Dataset Contract

Canonical import format:

```csv
hash160,balance_sats
00112233445566778899aabbccddeeff00112233,150000
aabbccddeeff0011223344556677889900112233,25000000
```

Build output:

```text
address_dataset.bin
```

Binary record format:

```text
20 bytes hash160 || 8 bytes uint64_be balance_sats
```

Records are sorted by `hash160`. Zero-balance rows are dropped. Duplicate `hash160` rows are aggregated.

## Commands

Create a synthetic local sample:

```bash
npm run dataset:sample -- --count 100000 --out data/sample-address_dataset.csv
```

Build binary dataset:

```bash
npm run dataset:build -- --input data/sample-address_dataset.csv --out data/address_dataset.bin
```

Lookup one hash:

```bash
npm run dataset:lookup -- --dataset data/address_dataset.bin --hash160 00112233445566778899aabbccddeeff00112233 --mode hashmap
```

Export public addresses for manual block explorer checks:

```bash
npm run dataset:export-addresses -- --dataset data/address_dataset.bin --out data/address_balances.csv
```

Import real public addresses, including 32-byte P2WSH/P2TR script keys:

```bash
npm run dataset:import-addresses -- --input data/real-addresses.csv --out data/real-script_dataset.csv
```

The real address CSV includes public address, script type, script key, sats, BTC amount, explorer URL, and source metadata.

Benchmark:

```bash
npm run dataset:bench -- --dataset data/address_dataset.bin --lookups 100000 --mode hashmap
npm run dataset:bench -- --dataset data/address_dataset.bin --lookups 100000 --mode binary
```

## Engine Options

HashMap mode:

- O(1) average lookup.
- Best for high-throughput RNG experiments.
- Requires RAM for the whole dataset plus Map overhead.

Binary mode:

- O(log n) lookup over sorted fixed-width records.
- Much lower implementation complexity.
- Uses less memory than HashMap if later switched to mmap/native code.

Recommended production path:

- Bloom filter in RAM for fast negative checks.
- LMDB/RocksDB or mmap sorted file as secondary lookup.
- Keep `hash160`/script identifier as the key, not Base58/Bech32 strings.

## Acquisition Evaluation

### Option A: Bitcoin Core Full Node

Best source of truth for this project.

Bitcoin Core exposes `dumptxoutset`, which writes a serialized UTXO set snapshot to disk, and reports `coins_written`, `base_hash`, `base_height`, `txoutset_hash`, and chain transaction count. That snapshot is the right primitive because we only need current unspent outputs, not full address history.

Recommended extraction pipeline:

```text
Bitcoin Core fully synced
  -> bitcoin-cli dumptxoutset utxo.dat
  -> parse UTXO records
  -> decode scriptPubKey
  -> extract key:
       P2PKH: OP_DUP OP_HASH160 <20-byte hash160> OP_EQUALVERIFY OP_CHECKSIG
       P2WPKH: OP_0 <20-byte hash160>
       P2SH: OP_HASH160 <20-byte script hash> OP_EQUAL
       P2TR: OP_1 <32-byte x-only pubkey>
  -> aggregate balance by script identifier
  -> write canonical CSV / binary dataset
```

For the requested `hash160,balance_sats` dataset, P2PKH and P2WPKH are direct 20-byte keys. P2SH is also 20 bytes but identifies a script hash, not a public-key hash. Taproot is 32 bytes, so production should either use a `script_key,balance_sats,type` schema or maintain separate datasets per script type.

Verdict: recommended for canonical dataset generation.

### Option B: Existing Indexers

Electrs:

- Good for local wallet/address queries.
- Uses a RocksDB-backed index.
- Maintains transaction input/output indexes and supports fast balance queries.
- Better as an online local service than as the canonical exporter unless we write a database walker.

Esplora / esplora-electrs:

- Good HTTP API and explorer stack.
- More storage-heavy, built for explorer workloads.
- Useful for validation and cross-checking.
- Overkill if the only goal is `current script/address -> balance`.

Fulcrum:

- Fast Electrum-compatible server.
- Good if we want a high-performance local Electrum query service.
- Not the simplest path for producing a compact fixed dataset.

Verdict: indexers are useful for validation and local API service, but Bitcoin Core UTXO snapshot parsing is the cleaner path for this phase.

## Real Dataset Storage Estimates

The exact real values must come from a synced node at snapshot time. The build manifest records the final counts and SHA-256.

Fixed-width binary size:

```text
P2PKH/P2WPKH/P2SH 20-byte key dataset: address_count * 28 bytes
Taproot 32-byte key dataset: address_count * 40 bytes
```

Approximate examples:

```text
10M 20-byte records  -> 280 MB raw
50M 20-byte records  -> 1.4 GB raw
100M 20-byte records -> 2.8 GB raw
```

HashMap RAM is usually several times raw binary size because of object/hash-table overhead. mmap or LMDB/RocksDB is better for very large datasets; HashMap is fastest if RAM is plentiful.
