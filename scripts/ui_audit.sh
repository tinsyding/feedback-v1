#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/../feedback-v1"

echo "=========================================="
echo "  Feedback UI Unslop Metric Audit"
echo "=========================================="

shopt -s extglob
TARGET_FILES=(css/*.css !(403|404|500|502|503|50x).html tools/sender_py/web_ui.html)
HTML_FILES=(!(403|404|500|502|503|50x).html)

count_metric() {
    local label="$1"
    local pattern="$2"
    shift 2
    local count
    count=$(grep -rEoh "$pattern" "$@" 2>/dev/null | wc -l || echo 0)
    printf "%-32s : %5d\n" "$label" "$count"
}

count_metric "linear-gradient" "linear-gradient" "${TARGET_FILES[@]}"
count_metric "radial-gradient" "radial-gradient" "${TARGET_FILES[@]}"
count_metric "backdrop-filter (glass)" "backdrop-filter" "${TARGET_FILES[@]}"
count_metric "colored glow / shadow" "box-shadow:[^;]*rgba\((99|102|124|139|79|59|168|236|147|16|34|37)" "${TARGET_FILES[@]}"
count_metric "font-weight: 700|800|900" "font-weight:\s*(700|800|900|bold)" "${TARGET_FILES[@]}"
count_metric "text-transform: uppercase" "text-transform:\s*uppercase" "${TARGET_FILES[@]}"
count_metric "transition: all" "transition:\s*all" "${TARGET_FILES[@]}"
count_metric "JS inline linear-gradient" "linear-gradient" js/*.js js/admin/*.js js/upload/*.js
count_metric "loop/shimmer animations" "(emptyFloat|focusDotPulse|qbPulseDot|qbShimmer|bounceGuide|orbit|pulse-optional)" "${TARGET_FILES[@]}"
count_metric "hover scale / translate" "scale\(1\.0[2-9]|scale\(1\.1|translateY\(-[2-9]px" "${TARGET_FILES[@]}"

EMOJI_COUNT=$(grep -rohP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}\x{2B50}]' "${HTML_FILES[@]}" js/*.js js/admin/*.js js/upload/*.js tools/sender_py/web_ui.html 2>/dev/null | wc -l || echo 0)
printf "%-32s : %5d\n" "Emoji count (symbols)" "$EMOJI_COUNT"

EXCLAMATION_COUNT=$(grep -roP '[！]|[^=!]![\x27"`<]' "${HTML_FILES[@]}" js/*.js js/admin/*.js tools/sender_py/web_ui.html 2>/dev/null | wc -l || echo 0)
printf "%-32s : %5d\n" "Exclamation marks in UI" "$EXCLAMATION_COUNT"

echo "=========================================="
