# Real Address Balance Dataset

Primary dataset for the POC:

```text
address<TAB>balance_sats
```

Source:

```text
https://gz.blockchair.com/bitcoin/addresses/blockchair_bitcoin_addresses_latest.tsv.gz
```

Local path:

```text
data/blockchair_bitcoin_addresses_latest.tsv.gz
```

This dump contains real Bitcoin addresses with current balances according to Blockchair's public dump. It is large and should not be committed to git.

## Main POC Lookup

The native runner loads the dump and checks generated public addresses directly:

```text
RNG private key
  -> P2PKH address
  -> P2WPKH address
  -> local address dump lookup
  -> balance?
```

Run via the repo script:

```bash
./run.sh
```

Windows:

```powershell
.\run.ps1
```

No npm is required for the main POC.

## Human Verification

The dump is human-checkable because the key is the public address itself.

Example row:

```text
bc1qwzrryqr3ja8w7hnja2spmkgfdcgvqwp5swz4af4ngsjecfz0w0pqud7k38<TAB>21394460159
```

Manual explorer URL:

```text
https://blockstream.info/address/<address>
```

## Dataset Safety

The runner refuses small/partial dumps by default. This prevents accidentally treating a seed file as the full real dataset.

Seed testing only:

```bash
./dist/rng-native-darwin-arm64 --address-dump data/real-address-balances.csv --samples 10 --allow-small-dump
```

## Storage

Blockchair currently publishes this dump as a multi-GB gzip file. Loading it into memory requires enough RAM for:

- compressed file on disk
- decompressed line streaming
- address map in memory

The final long-running POC should run on the Windows server with more RAM/storage.

The small Mac can be used for:

- release binary smoke tests
- seed-file tests
- command validation

## Legacy Utilities

The older Node/npm dataset tools remain in the repository only as reference utilities. They are no longer the main POC path.

## Alternative Source Of Truth

For a self-verified dataset instead of a trusted public dump:

```text
pruned Bitcoin Core
  -> current UTXO snapshot
  -> address,balance export
```

See [BITCOIN_CORE_PRUNED.md](BITCOIN_CORE_PRUNED.md).
