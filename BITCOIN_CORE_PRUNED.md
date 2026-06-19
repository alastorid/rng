# Full Real Dataset Without TB Storage

We do **not** need an archival full node for this project.

We need the current Bitcoin UTXO set:

```text
all currently unspent outputs -> script_key/address_type -> balance_sats
```

A pruned Bitcoin Core node keeps the current validated chainstate/UTXO set while deleting old block files. That is the right storage model for this dataset phase.

## Disk Expectation

Pruned mode avoids TB-scale block storage. You still need room for:

- Bitcoin Core chainstate / indexes
- Recent pruned block files
- The exported UTXO snapshot
- Our generated SQLite/CSV dataset

Plan for tens of GB, not TB. Leave comfortable extra space because initial sync and export need working room.

## Bitcoin Core Config

Create or edit:

```text
~/Library/Application Support/Bitcoin/bitcoin.conf
```

Recommended starting config:

```ini
server=1
prune=25000
dbcache=4096
rpcuser=bitcoinrpc
rpcpassword=choose-a-local-password
```

Notes:

- `prune=25000` keeps roughly 25 GB of recent block files.
- Increase it if you have more SSD.
- This node still validates the chain; it just does not retain all historical block files.

## Generate Real Dataset

After Bitcoin Core is synced:

```bash
bitcoin-cli getblockchaininfo
bitcoin-cli gettxoutsetinfo
```

Then export the current UTXO set:

```bash
bitcoin-cli dumptxoutset /path/to/utxo.dat
```

The next implementation step is a parser for `utxo.dat` that writes:

```csv
script_key,address_type,address,balance_sats,balance_btc,explorer_url,source
```

That output becomes:

```text
data/real-script_dataset.csv
```

Then the RNG POC runs completely offline:

```bash
npm run start:local -- --continuous --delay-ms 0
```

## Why Not Third-Party Dumps?

Third-party dumps may be useful for bootstrap testing, but they are less convincing:

- They can be stale.
- They may omit address/script types.
- Their transformation rules may be unclear.
- They add a data trust dependency.

For the strongest proof chain, use pruned Bitcoin Core plus a locally generated UTXO dataset.
