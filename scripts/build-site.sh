#!/usr/bin/env bash
# 組出手機版網站：web/ 的頁面加上共用的 lib/、vendor/。資料（data/）由 build-data.mjs 另外產生。
set -euo pipefail
OUT="${1:-_site}"
mkdir -p "$OUT"
cp -R web/. "$OUT/"
mkdir -p "$OUT/lib" "$OUT/vendor"
cp lib/*.js "$OUT/lib/"
cp vendor/lightweight-charts.standalone.production.js "$OUT/vendor/"
touch "$OUT/.nojekyll"
