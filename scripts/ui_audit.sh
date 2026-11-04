#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/../feedback-v1"

echo "=========================================="
echo "  Feedback UI Unslop Metric Audit"
echo "=========================================="

count_metric() {
    local label="$1"
    local pattern="$2"
    shift 2
    local count
    count=$(grep -rEoh "$pattern" "$@" 2>/dev/null | wc -l || echo 0)
    printf "%-32s : %5d\n" "$label" "$count"
}

count_metric "linear-gradient" "linear-gradient" css/*.css *.html tools/sender_py/web_ui.html
count_metric "radial-gradient" "radial-gradient" css/*.css *.html tools/sender_py/web_ui.html
count_metric "backdrop-filter (glass)" "backdrop-filter" css/*.css *.html tools/sender_py/web_ui.html
count_metric "colored glow / shadow" "box-shadow:[^;]*rgba\((99|102|124|139|79|59|168|236|147|16|34|37)" css/*.css *.html tools/sender_py/web_ui.html
count_metric "font-weight: 700|800|900" "font-weight:\s*(700|800|900|bold)" css/*.css *.html tools/sender_py/web_ui.html
count_metric "text-transform: uppercase" "text-transform:\s*uppercase" css/*.css *.html tools/sender_py/web_ui.html
count_metric "transition: all" "transition:\s*all" css/*.css *.html tools/sender_py/web_ui.html
count_metric "loop/shimmer animations" "(emptyFloat|focusDotPulse|qbPulseDot|qbShimmer|bounceGuide|orbit|pulse-optional)" css/*.css *.html tools/sender_py/web_ui.html
count_metric "hover scale / translate" "scale\(1\.0[2-9]|scale\(1\.1|translateY\(-[2-9]" css/*.css *.html tools/sender_py/web_ui.html

EMOJI_COUNT=$(grep -rohP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}\x{2B50}]' *.html js/*.js js/admin/*.js tools/sender_py/web_ui.html 2>/dev/null | wc -l || echo 0)
printf "%-32s : %5d\n" "Emoji count (symbols)" "$EMOJI_COUNT"

EXCLAMATION_COUNT=$(grep -roP '[！]|[^=!]![\x27"`<]' *.html js/*.js js/admin/*.js tools/sender_py/web_ui.html 2>/dev/null | wc -l || echo 0)
printf "%-32s : %5d\n" "Exclamation marks in UI" "$EXCLAMATION_COUNT"

echo "=========================================="
