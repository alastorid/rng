#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o dist/rng-native-darwin-arm64 ./cmd/rng-native
