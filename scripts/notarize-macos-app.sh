#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP="${1:-${PROJECT_ROOT}/dist/Busy Agents.app}"
PROFILE="${NOTARY_KEYCHAIN_PROFILE:-}"

if [[ ! -d "${APP}" ]]; then
  echo "还没有可公证的应用。请先运行 npm run build:mac"
  exit 1
fi

if [[ -z "${PROFILE}" ]]; then
  echo "还不能公证。换一台 Mac 直接打开，需要 Developer ID 签名和 Apple 公证。"
  echo "1. 用开发者证书构建："
  echo "   CODESIGN_IDENTITY='Developer ID Application: 名字 (TEAMID)' npm run build:mac"
  echo "2. 保存公证凭据："
  echo "   xcrun notarytool store-credentials AI_TASK_RADAR_NOTARY --apple-id you@example.com --team-id TEAMID"
  echo "3. 提交公证："
  echo "   NOTARY_KEYCHAIN_PROFILE=AI_TASK_RADAR_NOTARY npm run notarize:mac"
  exit 1
fi

ARCHIVE="$(mktemp -t ai-task-radar-notarize).zip"
ditto -c -k --keepParent "${APP}" "${ARCHIVE}"
xcrun notarytool submit "${ARCHIVE}" --keychain-profile "${PROFILE}" --wait
rm -f "${ARCHIVE}"
xcrun stapler staple "${APP}"
echo "已公证：${APP}"
