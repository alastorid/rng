#!/usr/bin/env bash
set -euo pipefail

curl -fL https://gz.blockchair.com/bitcoin/addresses/blockchair_bitcoin_addresses_latest.tsv.gz -o data/blockchair_bitcoin_addresses_latest.tsv.gz
npm run start:local -- --continuous --delay-ms 0
