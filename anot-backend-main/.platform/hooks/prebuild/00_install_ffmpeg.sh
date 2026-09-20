#!/bin/bash
# AL2023 Node.js platform: ffmpeg is NOT in the default dnf repos (patent-encumbered
# codecs), so audioProcessingService.js's ffmpegAvailable() check silently returns
# false without this — the silence-strip preprocessing that's supposed to cut ~35-40%
# of billed Deepgram minutes (see .env FFMPEG_* comments) never runs, and every visit
# is transcribed at full, un-preprocessed length.
#
# This installs a static, self-contained ffmpeg build (no dnf, no codec licensing
# issue) to /usr/local/bin so it's on PATH for the node user before the app starts.
set -euo pipefail

FFMPEG_BIN="/usr/local/bin/ffmpeg"

if [ -x "$FFMPEG_BIN" ]; then
  echo "[prebuild] ffmpeg already installed: $("$FFMPEG_BIN" -version | head -1)"
  exit 0
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  FFMPEG_ARCH="amd64" ;;
  aarch64) FFMPEG_ARCH="arm64" ;;
  *) echo "[prebuild] Unsupported arch for static ffmpeg: $ARCH" >&2; exit 1 ;;
esac

echo "[prebuild] Installing static ffmpeg (${FFMPEG_ARCH}) for audio preprocessing..."

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${FFMPEG_ARCH}-static.tar.xz"
curl -fsSL -o "$TMP_DIR/ffmpeg.tar.xz" "$URL"

tar -xJf "$TMP_DIR/ffmpeg.tar.xz" -C "$TMP_DIR"

# The archive extracts to a versioned dir like ffmpeg-7.1-amd64-static/
EXTRACTED_DIR="$(find "$TMP_DIR" -maxdepth 1 -type d -name 'ffmpeg-*-static')"
if [ -z "$EXTRACTED_DIR" ]; then
  echo "[prebuild] ffmpeg archive layout unexpected, aborting" >&2
  exit 1
fi

install -m 0755 "$EXTRACTED_DIR/ffmpeg" "$FFMPEG_BIN"
install -m 0755 "$EXTRACTED_DIR/ffprobe" /usr/local/bin/ffprobe

echo "[prebuild] ffmpeg installed: $("$FFMPEG_BIN" -version | head -1)"
