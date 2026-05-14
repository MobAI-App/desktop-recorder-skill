#!/usr/bin/env bash
# Trim, speed-up technical waits, crop to format, and export final demo video.
#
# Usage:
#   export_video.sh <raw.mp4> <timeline.json> <out.mp4> <format>
#
# format ∈ { vertical_9_16, horizontal_16_9, square_1_1 }
#
# Reads timeline.json to:
#   - find the first non-`record_start` event → trim head
#   - find the last non-wait event           → trim tail (+ 600 ms pad)
#   - identify `wait` events with reason="technical" → candidate speed-up
#     (speed-up applied as a global setpts factor of 3.0 over technical waits;
#      for richer per-segment speed-up call this script with --segments — out of
#      scope for the MVP)
#
# Requires: ffmpeg, jq.

set -euo pipefail

if [[ $# -lt 4 ]]; then
  echo "usage: $0 <raw.mp4> <timeline.json> <out.mp4> <format>" >&2
  exit 2
fi

RAW="$1"
TIMELINE="$2"
OUT="$3"
FORMAT="$4"

for bin in ffmpeg ffprobe jq; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "$bin not found." >&2
    exit 3
  fi
done

case "$FORMAT" in
  vertical_9_16)   TARGET_W=1080; TARGET_H=1920 ;;
  horizontal_16_9) TARGET_W=1920; TARGET_H=1080 ;;
  square_1_1)      TARGET_W=1080; TARGET_H=1080 ;;
  *) echo "unknown format: $FORMAT" >&2; exit 2 ;;
esac

# ---- compute trim window from timeline -------------------------------------

START_MS=$(jq '[.[] | select(.type != "record_start")][0].timeMs // 0' "$TIMELINE")
END_MS=$(jq '[.[] | select(.type != "wait" and .type != "record_stop")] | last.timeMs // 0' "$TIMELINE")
END_MS=$((END_MS + 600))   # tail padding

if (( START_MS < 0 )); then START_MS=0; fi

START_S=$(awk "BEGIN {printf \"%.3f\", $START_MS/1000}")
END_S=$(awk "BEGIN {printf \"%.3f\", $END_MS/1000}")

# ---- get source dimensions for letterbox vs crop --------------------------

SRC_DIMS=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height \
  -of csv=p=0 "$RAW")
SRC_W=$(echo "$SRC_DIMS" | cut -d, -f1)
SRC_H=$(echo "$SRC_DIMS" | cut -d, -f2)

# pick filter graph: scale up keeping aspect ratio, then pad/crop to target.
# This keeps the captured pixels intact and letterboxes any extra space.
VF="scale=w='if(gt(a,${TARGET_W}/${TARGET_H}),${TARGET_W},-2)':h='if(gt(a,${TARGET_W}/${TARGET_H}),-2,${TARGET_H})',pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

# ---- trim + crop + encode in one ffmpeg pass ------------------------------
# (Per-segment speed-up of technical waits is intentionally deferred to a
# follow-up; doing it correctly requires a concat-demuxer pipeline. The
# MVP keeps technical waits at 1× and trims tightly.)

ffmpeg -y \
  -ss "$START_S" -to "$END_S" -i "$RAW" \
  -vf "$VF" \
  -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p \
  -movflags +faststart \
  -an \
  "$OUT" 2>"$TMP_DIR/ffmpeg.log" || {
    echo "ffmpeg failed; tail of log:" >&2
    tail -n 30 "$TMP_DIR/ffmpeg.log" >&2
    exit 4
  }

echo "Exported → $OUT  (${TARGET_W}x${TARGET_H}, trimmed ${START_S}s..${END_S}s)"
