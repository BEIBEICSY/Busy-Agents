#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SOURCE_DIR="${PROJECT_ROOT}/macos/AITaskRadar"
DIST_DIR="${PROJECT_ROOT}/dist"
APP_BUNDLE="${DIST_DIR}/Busy Agents.app"
BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ai-task-radar-build.XXXXXX")"
BUILD_APP="${BUILD_ROOT}/Busy Agents.app"
ARCH="$(uname -m)"

cleanup() {
  rm -rf "${BUILD_ROOT}"
}
trap cleanup EXIT

mkdir -p "${BUILD_APP}/Contents/MacOS"
mkdir -p "${BUILD_APP}/Contents/Resources/backend"

cp -R "${SOURCE_DIR}/Resources/AppIcon.iconset" "${BUILD_ROOT}/AppIcon.iconset"
iconutil -c icns "${BUILD_ROOT}/AppIcon.iconset" -o "${BUILD_APP}/Contents/Resources/AppIcon.icns"
cp "${SOURCE_DIR}/Resources/MenuBarIcon.png" "${BUILD_APP}/Contents/Resources/MenuBarIcon.png"
cp "${SOURCE_DIR}/Resources/MenuBarIcon-64.png" "${BUILD_APP}/Contents/Resources/MenuBarIcon-64.png"

swiftc \
  -parse-as-library \
  -target "${ARCH}-apple-macos13.0" \
  -module-cache-path "${BUILD_ROOT}/ModuleCache" \
  -framework AppKit \
  -framework SwiftUI \
  "${SOURCE_DIR}/NodeLookup.swift" \
  "${SOURCE_DIR}/AITaskRadarApp.swift" \
  -o "${BUILD_APP}/Contents/MacOS/AITaskRadar"

cp "${SOURCE_DIR}/Info.plist" "${BUILD_APP}/Contents/Info.plist"
for localization in en zh-Hans zh-Hans-CN zh_CN; do
  cp -R "${SOURCE_DIR}/${localization}.lproj" "${BUILD_APP}/Contents/Resources/${localization}.lproj"
done
cp "${PROJECT_ROOT}/package.json" "${BUILD_APP}/Contents/Resources/backend/package.json"
cp -R "${PROJECT_ROOT}/config" "${BUILD_APP}/Contents/Resources/backend/config"
cp -R "${PROJECT_ROOT}/public" "${BUILD_APP}/Contents/Resources/backend/public"
cp -R "${PROJECT_ROOT}/src" "${BUILD_APP}/Contents/Resources/backend/src"

SIGN_IDENTITY="${CODESIGN_IDENTITY:--}"
NODE_BIN="${BUILD_APP}/Contents/Resources/runtime/bin/node"
# 内置 Node 先保留，不进默认安装包。需要时再执行 BUNDLE_NODE=1 npm run build:mac。
if [[ "${BUNDLE_NODE:-}" == "1" ]]; then
  bash "${SCRIPT_DIR}/fetch-node-runtime.sh" "${BUILD_APP}/Contents/Resources/runtime"
  if [[ "${SIGN_IDENTITY}" == "-" ]]; then
    codesign --force --sign - "${NODE_BIN}"
  else
    codesign --force --options runtime --timestamp \
      --entitlements "${SOURCE_DIR}/NodeRuntime.entitlements" \
      --sign "${SIGN_IDENTITY}" "${NODE_BIN}"
  fi
fi

if [[ "${SIGN_IDENTITY}" == "-" ]]; then
  codesign --force --deep --sign - "${BUILD_APP}"
else
  codesign --force --options runtime --timestamp --sign "${SIGN_IDENTITY}" "${BUILD_APP}"
fi

mkdir -p "${DIST_DIR}"
if [[ -e "${APP_BUNDLE}" ]]; then
  rm -rf "${APP_BUNDLE}"
fi
mv "${BUILD_APP}" "${APP_BUNDLE}"

echo "已生成：${APP_BUNDLE}"
