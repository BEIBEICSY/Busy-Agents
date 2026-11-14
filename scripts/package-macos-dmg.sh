#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP="${1:-${PROJECT_ROOT}/dist/Busy Agents.app}"
VOLNAME="Agents 在忙啥"
DMG_NAME="Agents 在忙啥-Busy Agents.dmg"
DMG="${PROJECT_ROOT}/dist/${DMG_NAME}"
PROFILE="${NOTARY_KEYCHAIN_PROFILE:-AI_TASK_RADAR_NOTARY}"
LINK_NAME="应用程序"

WINDOW_LEFT=200
WINDOW_TOP=120
WINDOW_WIDTH=640
WINDOW_HEIGHT=440
IMAGE_HEIGHT=400
ICON_SIZE=128
APP_X=160
APP_Y=168
LINK_X=480
LINK_Y=168

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ai-task-radar-dmg.XXXXXX")"
RW="${WORK}/rw.dmg"
BACKGROUND="${WORK}/background.png"
DEVICE=""

cleanup() {
  if [[ -n "${DEVICE}" ]]; then
    hdiutil detach "${DEVICE}" -force >/dev/null 2>&1 || true
  fi
  rm -rf "${WORK}"
}
trap cleanup EXIT

if [[ ! -d "${APP}" ]]; then
  echo "还没有可打包的应用。请先运行 npm run build:mac"
  exit 1
fi

ICON="${APP}/Contents/Resources/AppIcon.icns"
if [[ ! -f "${ICON}" ]]; then
  echo "应用里没有现成图标，安装盘不能带上 logo"
  exit 1
fi
cp "${ICON}" "${WORK}/AppIcon.icns"

apply_dmg_file_icon() {
  local target="$1"
  swift - "${WORK}/AppIcon.icns" "${target}" <<'SWIFT'
import AppKit
import Foundation

let arguments = CommandLine.arguments
guard arguments.count == 3,
      let image = NSImage(contentsOf: URL(fileURLWithPath: arguments[1])) else {
  fputs("没有读到现有应用图标\n", stderr)
  exit(1)
}
if !NSWorkspace.shared.setIcon(image, forFile: arguments[2], options: []) {
  fputs("没有把图标设置到安装盘文件\n", stderr)
  exit(1)
}
SWIFT
}

publish_dmg_icon() {
  apply_dmg_file_icon "${DMG}"
  # 直接覆盖桌面上已打开的文件时，访达可能写回旧的空资源叉。图标要在副本落地后再设一次。
  if [[ -d "${HOME}/Desktop" ]]; then
    ditto "${DMG}" "${HOME}/Desktop/${DMG_NAME}"
    apply_dmg_file_icon "${HOME}/Desktop/${DMG_NAME}"
    rm -f "${HOME}/Desktop/Busy Agents.dmg"
  fi
}

if [[ -d "/Volumes/${VOLNAME}" ]]; then
  hdiutil detach "/Volumes/${VOLNAME}" -force >/dev/null 2>&1 || true
fi

swift - "${BACKGROUND}" "${WINDOW_WIDTH}" "${IMAGE_HEIGHT}" "${APP_Y}" <<'SWIFT'
import AppKit
import Foundation

let url = URL(fileURLWithPath: CommandLine.arguments[1])
let width = Int(CommandLine.arguments[2]) ?? 640
let height = Int(CommandLine.arguments[3]) ?? 400
let iconCenterY = Int(CommandLine.arguments[4]) ?? 168
guard let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil,
  pixelsWide: width,
  pixelsHigh: height,
  bitsPerSample: 8,
  samplesPerPixel: 4,
  hasAlpha: true,
  isPlanar: false,
  colorSpaceName: .deviceRGB,
  bytesPerRow: 0,
  bitsPerPixel: 0
) else {
  fputs("安装窗口背景没有生成\n", stderr)
  exit(1)
}
rep.size = NSSize(width: width, height: height)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSColor(calibratedWhite: 1, alpha: 1).setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()

let arrowColor = NSColor(calibratedRed: 0.62, green: 0.62, blue: 0.66, alpha: 1)
arrowColor.setStroke()
let midY = CGFloat(height - iconCenterY)
let shaft = NSBezierPath()
shaft.lineWidth = 4
shaft.lineCapStyle = .round
shaft.move(to: NSPoint(x: 248, y: midY))
shaft.line(to: NSPoint(x: 372, y: midY))
shaft.stroke()
let head = NSBezierPath()
head.lineWidth = 4
head.lineCapStyle = .round
head.lineJoinStyle = .round
head.move(to: NSPoint(x: 352, y: midY + 14))
head.line(to: NSPoint(x: 382, y: midY))
head.line(to: NSPoint(x: 352, y: midY - 14))
head.stroke()

let caption = "拖到右侧文件夹即可安装" as NSString
let font = NSFont(name: "PingFangSC-Regular", size: 13) ?? NSFont.systemFont(ofSize: 13)
let attrs: [NSAttributedString.Key: Any] = [
  .font: font,
  .foregroundColor: NSColor(calibratedRed: 0.42, green: 0.42, blue: 0.45, alpha: 1)
]
let textSize = caption.size(withAttributes: attrs)
caption.draw(
  at: NSPoint(x: (CGFloat(width) - textSize.width) / 2, y: 48),
  withAttributes: attrs
)
NSGraphicsContext.restoreGraphicsState()

guard let png = rep.representation(using: .png, properties: [:]) else {
  fputs("安装窗口背景没有生成\n", stderr)
  exit(1)
}
try png.write(to: url)
SWIFT

PIXEL_WIDTH="$(sips -g pixelWidth "${BACKGROUND}" | awk '/pixelWidth/{print $2}')"
PIXEL_HEIGHT="$(sips -g pixelHeight "${BACKGROUND}" | awk '/pixelHeight/{print $2}')"
if [[ "${PIXEL_WIDTH}" != "${WINDOW_WIDTH}" || "${PIXEL_HEIGHT}" != "${IMAGE_HEIGHT}" ]]; then
  echo "安装窗口背景尺寸不对：${PIXEL_WIDTH}×${PIXEL_HEIGHT}"
  exit 1
fi

APP_KB="$(du -sk "${APP}" | awk '{print $1}')"
SIZE_MB="$(( APP_KB / 1024 + 48 ))"
hdiutil create -size "${SIZE_MB}m" -fs HFS+ -volname "${VOLNAME}" -ov "${RW}" >/dev/null

ATTACHED="$(hdiutil attach -readwrite -noverify -noautoopen "${RW}")"
DEVICE="$(printf '%s\n' "${ATTACHED}" | awk '/^\/dev\// {print $1; exit}')"
MOUNT="/Volumes/${VOLNAME}"
if [[ ! -d "${MOUNT}" ]]; then
  echo "安装磁盘没有挂载"
  exit 1
fi

ditto "${APP}" "${MOUNT}/Busy Agents.app"
ln -s /Applications "${MOUNT}/${LINK_NAME}"
mkdir -p "${MOUNT}/.background"
cp "${BACKGROUND}" "${MOUNT}/.background/background.png"

osascript <<EOF
tell application "Finder"
  tell disk "${VOLNAME}"
    open
    delay 1
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {${WINDOW_LEFT}, ${WINDOW_TOP}, $((WINDOW_LEFT + WINDOW_WIDTH)), $((WINDOW_TOP + WINDOW_HEIGHT))}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to ${ICON_SIZE}
    set text size of viewOptions to 13
    set background picture of viewOptions to file ".background:background.png"
    set position of item "Busy Agents.app" of container window to {${APP_X}, ${APP_Y}}
    set position of item "${LINK_NAME}" of container window to {${LINK_X}, ${LINK_Y}}
    update without registering applications
    delay 2
    close
  end tell
end tell
EOF

chflags hidden "${MOUNT}/.background"
# 访达设置窗口背景时会清掉磁盘图标，所以等窗口关闭后再放。
cp "${WORK}/AppIcon.icns" "${MOUNT}/.VolumeIcon.icns"
SETFILE="$(xcrun --find SetFile)"
"${SETFILE}" -c icnC "${MOUNT}/.VolumeIcon.icns"
"${SETFILE}" -a C "${MOUNT}"
sync
hdiutil detach "${DEVICE}" >/dev/null
DEVICE=""

mkdir -p "${PROJECT_ROOT}/dist"
rm -f "${DMG}"
hdiutil convert "${RW}" -format UDZO -imagekey zlib-level=9 -o "${DMG}" >/dev/null

IDENTITY="$(codesign -dv --verbose=4 "${APP}" 2>&1 | sed -n 's/^Authority=Developer ID Application: //p' | head -1)"
if [[ -z "${IDENTITY}" ]]; then
  publish_dmg_icon
  echo "已生成安装盘，但应用不是 Developer ID 签名，换一台 Mac 打开会被系统拦住。"
  echo "${DMG}"
  exit 0
fi

codesign --force --timestamp --sign "Developer ID Application: ${IDENTITY}" "${DMG}"

if [[ "${PACKAGE_SKIP_NOTARIZE:-}" == "1" ]]; then
  publish_dmg_icon
  echo "已生成安装盘，按要求跳过公证。"
  echo "${DMG}"
  exit 0
fi

xcrun notarytool submit "${DMG}" --keychain-profile "${PROFILE}" --wait
xcrun stapler staple "${DMG}"
rm -f "${PROJECT_ROOT}/dist/Busy Agents.dmg"
publish_dmg_icon
echo "已生成可发送的安装盘：${DMG}"
