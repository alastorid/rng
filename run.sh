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
REPO="${RNG_REPO:-github.com/alastorid/rng}"
DATA_BRANCH="${RNG_DATA_BRANCH:-data}"
DATA_WORKTREE=".cache/data-branch"
DATA_ARCHIVE_DIR="$DATA_WORKTREE/data/blockchair_bitcoin_addresses_latest"
EXTRACT_DIR="data/blockchair_bitcoin_addresses_latest_extracted"
RELEASE_TAG="${RNG_RELEASE_TAG:-native-latest}"
BACKEND="${RNG_BACKEND:-cpu}"

find_dump() {
  if [[ ! -d "$EXTRACT_DIR" ]]; then
    return
  fi
  find "$EXTRACT_DIR" -type f \( -name "*.tsv" -o -name "*.tsv.gz" -o -name "*.csv" \) | sort | head -n 1
}

ensure_data() {
  local dump
  dump="$(find_dump || true)"
  if [[ -n "$dump" && -f "$dump" ]]; then
    printf '%s\n' "$dump"
    return
  fi

  echo "Fetching dataset archive parts from git branch '$DATA_BRANCH'..." >&2
  git fetch origin "$DATA_BRANCH:refs/remotes/origin/$DATA_BRANCH" --depth=1 >&2
  mkdir -p .cache
  if [[ -d "$DATA_WORKTREE/.git" || -f "$DATA_WORKTREE/.git" ]]; then
    git -C "$DATA_WORKTREE" reset --hard "origin/$DATA_BRANCH" >&2
  else
    rm -rf "$DATA_WORKTREE"
    git worktree add --force --detach "$DATA_WORKTREE" "origin/$DATA_BRANCH" >&2
  fi

  if [[ ! -f "$DATA_ARCHIVE_DIR/blockchair_bitcoin_addresses_latest.7z.001" ]]; then
    echo "Cannot find split 7z dataset at $DATA_ARCHIVE_DIR" >&2
    exit 1
  fi

  local sevenz
  sevenz="$(command -v 7z || command -v 7zz || true)"
  if [[ -z "$sevenz" ]]; then
    echo "7z is required to extract the dataset. On macOS: brew install p7zip" >&2
    exit 1
  fi

  echo "Extracting dataset locally..." >&2
  rm -rf "$EXTRACT_DIR"
  mkdir -p "$EXTRACT_DIR"
  "$sevenz" x "$DATA_ARCHIVE_DIR/blockchair_bitcoin_addresses_latest.7z.001" "-o$EXTRACT_DIR" -y >&2

  dump="$(find_dump || true)"
  if [[ -z "$dump" || ! -f "$dump" ]]; then
    echo "Dataset extracted, but no .tsv/.tsv.gz/.csv file was found in $EXTRACT_DIR" >&2
    exit 1
  fi
  printf '%s\n' "$dump"
}

if [[ ! -x "$BIN" ]]; then
  if command -v gh >/dev/null 2>&1; then
    gh release download "$RELEASE_TAG" --repo "$REPO" --pattern rng-native-darwin-arm64 --dir dist --clobber
  elif [[ -n "${GITHUB_TOKEN:-}" ]]; then
    ASSET_ID="$(
      curl -fsSL -H "Authorization: Bearer ${GITHUB_TOKEN}" \
        "https://api.github.com/repos/alastorid/rng/releases/tags/${RELEASE_TAG}" |
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

if [[ "$BACKEND" == "opencl" ]]; then
  echo "This binary can list OpenCL devices, but the OpenCL key-generation backend is not implemented yet." >&2
  "$BIN" --list-devices || true
  exit 1
fi

DUMP="$(ensure_data)"
"$BIN" --backend "$BACKEND" --address-dump "$DUMP" --continuous --delay-ms 0 --progress-interval 5s
