#!/bin/sh
set -e
cd "$(dirname "$0")"
APP=build/Leon.app
PNG=../packages/web/public/leon.png

rm -rf "$APP" build/leon.iconset
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" build/leon.iconset

swiftc -O -swift-version 5 -target arm64-apple-macos15 Sources/*.swift -o "$APP/Contents/MacOS/Leon"
"$APP/Contents/MacOS/Leon" --self-test

cp "$PNG" "$APP/Contents/Resources/leon.png"
for size in 16 32 128 256; do
  sips -z $size $size "$PNG" --out "build/leon.iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z $double $double "$PNG" --out "build/leon.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns build/leon.iconset -o "$APP/Contents/Resources/Leon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Leon</string>
  <key>CFBundleIdentifier</key><string>ai.accomplish.leon.avatar</string>
  <key>CFBundleExecutable</key><string>Leon</string>
  <key>CFBundleIconFile</key><string>Leon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP"
echo "built $(pwd)/$APP"
