#!/usr/bin/env bash
set -euo pipefail

# 下载固定版本的官方 Node.js，校验 SHA-256 后只取出可执行文件和许可证。
# 用法：scripts/fetch-node-runtime.sh <目标目录>
# 目标目录会得到 bin/node 和 LICENSE。压缩包缓存在 .cache/，不入库。

if [[ $# -ne 1 ]]; then
  echo "用法：scripts/fetch-node-runtime.sh <目标目录>" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEST="$1"
NODE_VERSION="22.22.3"

case "$(uname -m)" in
  arm64)
    NODE_ARCH="arm64"
    NODE_SHA256="0da7ff74ef8611328c8212f17943368713a2ad953fb7d89a8c8a0eae87c23207"
    ;;
  x86_64)
    NODE_ARCH="x64"
    NODE_SHA256="45830ba752fa0d892c6dcd640946669801293cac820a33591ded40ac075198ec"
    ;;
  *)
    echo "当前架构没有对应的 Node 运行时：$(uname -m)" >&2
    exit 1
    ;;
esac

NAME="node-v${NODE_VERSION}-darwin-${NODE_ARCH}"
CACHE="${PROJECT_ROOT}/.cache/node-runtime"
TARBALL="${CACHE}/${NAME}.tar.gz"
URL="https://nodejs.org/dist/v${NODE_VERSION}/${NAME}.tar.gz"

mkdir -p "${CACHE}" "${DEST}/bin"

checksum_ok() {
  echo "${NODE_SHA256}  $1" | shasum -a 256 -c - >/dev/null 2>&1
}

if [[ ! -f "${TARBALL}" ]] || ! checksum_ok "${TARBALL}"; then
  echo "正在下载 Node.js ${NODE_VERSION}（darwin-${NODE_ARCH}）"
  curl -fL --retry 3 --retry-delay 2 -o "${TARBALL}.partial" "${URL}"
  if ! checksum_ok "${TARBALL}.partial"; then
    rm -f "${TARBALL}.partial"
    echo "Node.js 安装包校验失败，已停止构建。" >&2
    exit 1
  fi
  mv "${TARBALL}.partial" "${TARBALL}"
fi

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/ai-task-radar-node.XXXXXX")"
cleanup() {
  rm -rf "${WORKDIR}"
}
trap cleanup EXIT

tar -xzf "${TARBALL}" -C "${WORKDIR}" "${NAME}/bin/node" "${NAME}/LICENSE"
cp "${WORKDIR}/${NAME}/bin/node" "${DEST}/bin/node"
cp "${WORKDIR}/${NAME}/LICENSE" "${DEST}/LICENSE"
chmod 755 "${DEST}/bin/node"
xattr -dr com.apple.quarantine "${DEST}" 2>/dev/null || true

VERSION="$("${DEST}/bin/node" --version)"
if [[ "${VERSION}" != "v${NODE_VERSION}" ]]; then
  echo "内置 Node 版本不对：${VERSION}" >&2
  exit 1
fi

echo "已准备 Node.js ${VERSION}：${DEST}/bin/node"
