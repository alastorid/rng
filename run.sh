#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

mkdir -p data dist logs

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "run.sh is for macOS Apple Silicon. Use run.ps1 on Windows." >&2
  exit 1
fi

BIN="dist/rng-native-darwin-arm64"
DUMP="data/blockchair_bitcoin_addresses_latest.tsv.gz"

if [[ ! -x "$BIN" ]]; then
  if command -v gh >/dev/null 2>&1; then
    gh release download native-latest --repo github.com/alastorid/rng --pattern rng-native-darwin-arm64 --dir dist --clobber
  elif [[ -n "${GITHUB_TOKEN:-}" ]]; then
    ASSET_ID="$(
      curl -fsSL -H "Authorization: Bearer ${GITHUB_TOKEN}" \
        "https://api.github.com/repos/alastorid/rng/releases/tags/native-latest" |
        python3 -c 'import json,sys; data=json.load(sys.stdin); print(next(a["id"] for a in data["assets"] if a["name"]=="rng-native-darwin-arm64"))'
    )"
    curl -fL \
      -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -H "Accept: application/octet-stream" \
      "https://api.github.com/repos/alastorid/rng/releases/assets/${ASSET_ID}" \
      -o "$BIN"
  else
    echo "Cannot download private release asset. Install/authenticate GitHub CLI with 'gh auth login', or set GITHUB_TOKEN." >&2
    exit 1
  fi
  chmod +x "$BIN"
fi

if [[ ! -f "$DUMP" ]]; then
  curl -fL "https://gz.blockchair.com/bitcoin/addresses/blockchair_bitcoin_addresses_latest.tsv.gz" -o "$DUMP"
fi

"$BIN" --address-dump "$DUMP" --continuous --delay-ms 0 --progress-interval 5s
