#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

mkdir -p data dist logs .cache

REPO="${RNG_REPO:-github.com/alastorid/rng}"
DATA_BRANCH="${RNG_DATA_BRANCH:-data}"
DATA_WORKTREE=".cache/data-branch"
DATA_ARCHIVE_DIR="$DATA_WORKTREE/data/blockchair_bitcoin_addresses_latest"
EXTRACT_DIR="data/blockchair_bitcoin_addresses_latest_extracted"
TARGETS_FILE="${RNG_TARGETS_FILE:-data/blockchair_bitcoin_addresses_latest_targets.txt}"
RELEASE_TAG="${RNG_RELEASE_TAG:-bitcrack-latest}"
BACKEND="${RNG_BACKEND:-opencl}"
KEYSPACE="${RNG_KEYSPACE:-}"
CONTINUE_FILE="${RNG_CONTINUE_FILE:-logs/bitcrack-${BACKEND}.continue}"
OUT_FILE="${RNG_OUT_FILE:-logs/hits.txt}"

if [[ -n "${RNG_BIN:-}" ]]; then
  ASSET_OPENCL=""
  BIN_OPENCL="$RNG_BIN"
else
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)
      ASSET_OPENCL="clBitCrack-linux-x64"
      BIN_OPENCL="dist/clBitCrack"
      ;;
    *)
      echo "run.sh currently supports Linux x86_64 prebuilt BitCrack assets." >&2
      echo "On Windows, use run.ps1. To use a local binary here, set RNG_BIN=/path/to/clBitCrack." >&2
      exit 1
      ;;
  esac
fi

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
    echo "7z is required to extract the dataset. Install p7zip/7-Zip and retry." >&2
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

ensure_targets() {
  local dump="$1"
  if [[ -s "$TARGETS_FILE" && "$TARGETS_FILE" -nt "$dump" ]]; then
    printf '%s\n' "$TARGETS_FILE"
    return
  fi

  echo "Preparing BitCrack target address list..." >&2
  mkdir -p "$(dirname "$TARGETS_FILE")"
  if [[ "$dump" == *.gz ]]; then
    gzip -cd "$dump"
  else
    cat "$dump"
  fi | awk -F '[,\t]' '
    {
      gsub(/\r/, "", $1)
      if ($1 ~ /^1[[:alnum:]]{20,}$/) print $1
    }
  ' > "$TARGETS_FILE.tmp"
  mv "$TARGETS_FILE.tmp" "$TARGETS_FILE"

  if [[ ! -s "$TARGETS_FILE" ]]; then
    echo "No supported P2PKH addresses were parsed from $dump" >&2
    exit 1
  fi
  printf '%s\n' "$TARGETS_FILE"
}

download_asset() {
  local asset="$1"
  local out="$2"

  if command -v gh >/dev/null 2>&1; then
    gh release download "$RELEASE_TAG" --repo "$REPO" --pattern "$asset" --dir dist --clobber
    mv "dist/$asset" "$out"
  elif [[ -n "${GITHUB_TOKEN:-}" ]]; then
    local asset_id
    asset_id="$(
      curl -fsSL -H "Authorization: Bearer ${GITHUB_TOKEN}" \
        "https://api.github.com/repos/${REPO#github.com/}/releases/tags/${RELEASE_TAG}" |
        python3 -c 'import json,sys; data=json.load(sys.stdin); name=sys.argv[1]; print(next(a["id"] for a in data["assets"] if a["name"]==name))' "$asset"
    )"
    curl -fL \
      -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -H "Accept: application/octet-stream" \
      "https://api.github.com/repos/${REPO#github.com/}/releases/assets/${asset_id}" \
      -o "$out"
  else
    echo "Cannot download private release asset. Install/authenticate GitHub CLI with 'gh auth login', or set GITHUB_TOKEN." >&2
    exit 1
  fi
  chmod +x "$out"
}

case "$BACKEND" in
  opencl|cl)
    BIN="${RNG_BIN:-$BIN_OPENCL}"
    ASSET="$ASSET_OPENCL"
    ;;
  *)
    echo "Unsupported RNG_BACKEND '$BACKEND' for run.sh. Use RNG_BACKEND=opencl." >&2
    exit 1
    ;;
esac

if [[ ! -x "$BIN" ]]; then
  if [[ -z "$ASSET" ]]; then
    echo "RNG_BIN points to '$BIN', but it is not executable." >&2
    exit 1
  fi
  echo "Downloading $ASSET from release '$RELEASE_TAG'..." >&2
  download_asset "$ASSET" "$BIN"
fi

DUMP="$(ensure_data)"
TARGETS="$(ensure_targets "$DUMP")"

ARGS=(--compressed --continue "$CONTINUE_FILE" -i "$TARGETS" -o "$OUT_FILE")
if [[ -n "$KEYSPACE" ]]; then
  ARGS+=(--keyspace "$KEYSPACE")
fi
if [[ -n "${RNG_DEVICE:-}" ]]; then
  ARGS+=(--device "$RNG_DEVICE")
fi
if [[ -n "${RNG_BLOCKS:-}" ]]; then
  ARGS+=(--blocks "$RNG_BLOCKS")
fi
if [[ -n "${RNG_THREADS:-}" ]]; then
  ARGS+=(--threads "$RNG_THREADS")
fi
if [[ -n "${RNG_POINTS:-}" ]]; then
  ARGS+=(--points "$RNG_POINTS")
fi

exec "$BIN" "${ARGS[@]}" "$@"
