#!/usr/bin/env bash
# Run on the new Ubuntu VPS after reviewing this file, not on the development Mac.
set -euo pipefail
if [[ "$(uname -s)" != Linux || "$EUID" != 0 ]]; then
  echo "Run this installer with sudo on the Ubuntu VPS." >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  aarch64|arm64) node_arch=arm64 ;;
  *) echo "Unsupported VPS architecture." >&2; exit 1 ;;
esac
node_tmp="$(mktemp -d)"
trap 'rm -rf -- "$node_tmp"' EXIT
cd "$node_tmp"
curl --fail --silent --show-error --location --output SHASUMS256.txt https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
node_archive="$(awk -v arch="$node_arch" '$2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") {print $2}' SHASUMS256.txt)"
if [[ ! "$node_archive" =~ ^node-v24\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]]; then
  echo "Could not select one official Node 24 archive." >&2; exit 1
fi
curl --fail --silent --show-error --location --output "$node_archive" "https://nodejs.org/dist/latest-v24.x/$node_archive"
awk -v archive="$node_archive" '$2 == archive' SHASUMS256.txt | sha256sum --check --strict
tar -xJf "$node_archive" --strip-components=1 --directory=/usr/local
/usr/local/bin/node --version
/usr/local/bin/npm --version
