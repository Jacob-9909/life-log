#!/bin/bash
# life-log 로컬 데몬 설치 (launchd)
# 사용법: ./scripts/install-daemon.sh <owner/repo> [github-token]
set -euo pipefail

REPO="${1:?사용법: install-daemon.sh <owner/repo> [github-token]}"
TOKEN="${2:-$(gh auth token)}"

if [[ -z "$TOKEN" ]]; then
  echo "GitHub 토큰을 찾을 수 없습니다. 인자로 넘기거나 gh auth login 후 재실행하세요."
  exit 1
fi

DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_DST="$HOME/Library/LaunchAgents/com.jacob.life-log.daemon.plist"
NODE_BIN="$(command -v node)"

mkdir -p "$DIR/daemon/logs"

sed -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__HOME__|$HOME|g" \
    -e "s|__REPO__|$REPO|g" \
    -e "s|__TOKEN__|$TOKEN|g" \
    "$DIR/daemon/com.jacob.life-log.daemon.plist.template" > "$PLIST_DST"

launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"

echo "✅ 데몬 설치 완료: $PLIST_DST"
echo "로그: $DIR/daemon/logs/"
echo "중지: launchctl unload $PLIST_DST"
