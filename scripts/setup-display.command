#!/bin/zsh
# Double-click (or `open`) to join a Samsung EMDX e-paper display to Wi-Fi over
# Bluetooth. Opens in Terminal and asks for the display's PIN, the Wi-Fi name
# and the Wi-Fi password (hidden while typing).
cd "${0:A:h}/.." || exit 1

# Terminal windows may not have nvm's node on PATH yet.
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh"
fi

[ -d macos/build/EMDXBridge.app ] || ./scripts/build-macos-bridge.sh
[ -d node_modules ] || npm install --silent

echo "Samsung e-paper Wi-Fi setup"
echo "---------------------------"
node bin/index.mjs setup
echo
echo "You can close this window now."
