# Pure RNG Bitcoin Address Sampling POC

This is a local proof-of-concept runner for independent random trials:

```text
OS entropy -> private key -> public key -> hash160 -> local dataset lookup -> evidence log
```

The program does not include transaction creation or spending logic. By default it logs public evidence plus a salted commitment to the private key, not the raw private key itself.

## Install

```bash
npm install
```

## Quick Smoke Test

```bash
npm run smoke
```

This derives two random keys and writes local logs without calling a chain API.

## Run Local Dataset Sampling

```bash
npm run start:local -- --samples 100 --delay-ms 0
```

For a long run:

```bash
npm run start:local -- --continuous --delay-ms 0
```

Stop with `Ctrl+C`.

Local mode uses `data/address_dataset.bin` and performs no network lookups. Each RNG key derives one compressed public-key hash160 and checks it locally. The two display addresses, P2PKH and P2WPKH, share that same hash160.

## Dataset Tools

Create or replace the sample dataset:

```bash
npm run dataset:sample -- --count 100000 --out data/sample-address_dataset.csv
npm run dataset:build -- --input data/sample-address_dataset.csv --out data/address_dataset.bin
```

Benchmark local lookup:

```bash
npm run dataset:bench -- --dataset data/address_dataset.bin --lookups 100000 --mode hashmap
npm run dataset:bench -- --dataset data/address_dataset.bin --lookups 100000 --mode binary
```

Export public addresses for manual checks:

```bash
npm run dataset:export-addresses -- --dataset data/address_dataset.bin --out data/address_balances.csv
```

See [DATASET.md](DATASET.md) for the dataset format and Bitcoin Core acquisition plan.

## Optional Remote API Mode

Remote mode is still available for quick comparison, but it is not the preferred experiment path:

```bash
npm start -- --samples 100 --delay-ms 500
```

## Optional Encrypted Hit Vault

Routine logs intentionally do not store raw private keys. For the simplest possible proof file, store raw key material for hits only:

```bash
npm run start:local -- --continuous --delay-ms 0 --store-hit-keys-plain
```

If an address ever appears on-chain, this writes `logs/*.proof-hit-keys.jsonl` with:

- private key hex
- compressed WIF
- derived address
- chain state at detection time
- the salted sample commitment

For a more private preservation record, set a passphrase in an environment variable and pass its name:

```bash
export RNG_POC_VAULT_PASS='choose-a-long-local-passphrase'
npm start -- --continuous --delay-ms 500 --vault-pass-env RNG_POC_VAULT_PASS
```

Only hit keys are encrypted into `logs/*.hit-keys.enc.jsonl`.

## Evidence Files

Every run writes:

- `logs/<run-id>.manifest.json`: run settings, OS/Node metadata, salt for commitments, final stats.
- `logs/<run-id>.samples.jsonl`: one append-only JSON record per sampled private key.
- `logs/<run-id>.hits.jsonl`: addresses that appeared on-chain, had history, or had balance.
- `logs/<run-id>.proof-hit-keys.jsonl`: optional plaintext proof material for hits only.
- `logs/<run-id>.hit-keys.enc.jsonl`: optional encrypted key material for hits only.

The private-key commitment is:

```text
sha256("rng-bitcoin-poc:v1:key-commitment" || runSalt || privateKey)
```

That lets you later prove that a revealed key matches a specific sample without publishing raw key material during normal operation.

## Address Formats Checked

For each private key this checks:

- compressed legacy P2PKH address
- native SegWit P2WPKH address

## Interpretation

Expected result under modern cryptographic assumptions: zero funded collisions.

If any hit appears, treat it first as an engineering incident to verify:

- address derivation
- RNG source
- dataset snapshot
- log integrity
- independent reproduction on another machine or implementation

Do not move funds from addresses you did not intentionally create.
