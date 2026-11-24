#!/usr/bin/env bash
# 用官方 llama.cpp b11913 + 本 repo 附的 unlimited-ocr2.patch 編譯 Linux 疊加包
# （libllama.so、libmtmd.so），對應 Windows 的 llama-b11913-unlimited-ocr2-win-x64.zip。
# 產物可解壓覆蓋官方 llama-b11913-bin-ubuntu-vulkan-{x64,arm64}.tar.gz。
set -euo pipefail
BUILD="${LLAMA_BUILD:-b11913}"
COMMIT="${LLAMA_COMMIT:-7aca0d2}"
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PATCH="$ROOT/scripts/patches/unlimited-ocr2.patch"
OUT="${1:-$PWD/llama-${BUILD}-unlimited-ocr2-linux-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/').tar.gz}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/axd-ocr2-XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
if [[ ! -f "$PATCH" ]]; then
  echo "找不到 $PATCH" >&2
  exit 1
fi
git clone --depth 1 --branch "$BUILD" https://github.com/ggml-org/llama.cpp.git "$WORK/src" || {
  git clone https://github.com/ggml-org/llama.cpp.git "$WORK/src"
  git -C "$WORK/src" checkout "$BUILD"
}
git -C "$WORK/src" apply --check "$PATCH"
git -C "$WORK/src" apply "$PATCH"
cmake -S "$WORK/src" -B "$WORK/build" -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF
cmake --build "$WORK/build" --parallel "${BUILD_JOBS:-$(nproc)}" --target llama mtmd
STAGE="$WORK/stage"
mkdir -p "$STAGE"
# 不同 CMake 產物路徑都找一遍
find "$WORK/build" -type f \( -name 'libllama.so*' -o -name 'libmtmd.so*' \) -exec cp -a {} "$STAGE/" \;
printf 'llama.cpp %s (%s) + llama.cpp-patch/unlimited-ocr2.patch\nOverlay for official Ubuntu vulkan tarball: replaces libllama.so and libmtmd.so only.\n' "$BUILD" "$COMMIT" > "$STAGE/axondeck-unlimited-ocr2.txt"
tar -C "$STAGE" -czf "$OUT" .
echo "wrote $OUT"
ls -l "$OUT" "$STAGE"
