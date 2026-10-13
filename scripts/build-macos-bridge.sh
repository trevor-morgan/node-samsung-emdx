#!/usr/bin/env bash
# Builds macos/build/EMDXBridge.app: the Bluetooth helper used by `samsung-emdx setup`.
# Requires Xcode command line tools (swiftc). The app is ad-hoc signed; macOS asks
# for Bluetooth permission the first time it runs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/macos/build/EMDXBridge.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$ROOT/macos/EMDXBridge/Info.plist" "$APP/Contents/Info.plist"
swiftc -O "$ROOT/macos/EMDXBridge/main.swift" -o "$APP/Contents/MacOS/EMDXBridge"
codesign --force -s - "$APP" >/dev/null 2>&1
echo "$APP"
