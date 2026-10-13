# Samsung EMDX

With this module you can set up a Samsung EMDX Color E-Paper display (e.g. the 32" EM32DX) and show images on it from the command line — no Samsung E-Paper phone app needed.

## 1. First-time Wi-Fi setup (macOS, over Bluetooth)

A new or reset display has no network connection; Samsung's app normally gives it your Wi-Fi details over Bluetooth. `setup` does the same from a Mac.

```bash
npm install
./scripts/build-macos-bridge.sh      # builds the small Bluetooth helper app (needs Xcode command line tools)
node bin/index.mjs setup
```

Or double-click `scripts/setup-display.command` in Finder.

Before running it:

1. On the display, hold the **Bluetooth button** until the blue light blinks (pairing mode). The screen shows a 6-digit PIN; it changes each time pairing mode starts.
2. If the Mac has paired with the display before, open **System Settings → Bluetooth**, click ⓘ next to the display and choose **Forget This Device**. The display discards its side of the pairing after every session, and macOS will not reconnect until its stale copy is gone.

`setup` asks for the PIN, the Wi-Fi name and the Wi-Fi password (typed hidden; never taken as an argument). It then sends the same sequence as Samsung's app — wired mode off, Wi-Fi network type, credentials, DHCP — and prints the display's IP address. If Bluetooth drops once the display switches to Wi-Fi, it finds the display on your network instead (Samsung control port 1515).

The first time, macOS asks whether **EMDXBridge** may use Bluetooth; choose **Allow**.

`node bin/index.mjs ble-status --pin <PIN>` reads the display's current Wi-Fi network and IP address over Bluetooth without changing anything.

## 2. Show an image (any OS, over the network)

```bash
node bin/index.mjs show-image \
  --host 192.168.0.123 \
  --pin 123456 \
  --mac 00:11:22:33:44:55 \
  --image ~/Photos/Doggy.jpg
```

* `--pin` is the display's 6-digit PIN (the same one used during setup).
* `--mac` (optional) is the display's **Wi-Fi** MAC address, used to wake it with Wake-on-LAN — it sleeps to save battery.
* The display only accepts PNG, so other formats are converted with macOS `sips`. The full panel is 2560 × 1440 (1440 × 2560 portrait).
* The display downloads the picture from a small web server on your computer, so it must be able to reach this computer; `--local-ip` overrides the address it is given.

Within a minute your display should repaint. Pushing the same image twice is a no-op: the content id is derived from the image bytes.

Tip: reserve the display's IP address in your router so it doesn't change.

## How it works

* **Bluetooth setup** speaks the protocol of Samsung's E-Paper app (the `SVCDeviceSetting` GATT service), summarised in [docs/BLE-PROTOCOL.md](docs/BLE-PROTOCOL.md). macOS only lets app bundles use Bluetooth, so `macos/EMDXBridge` is a tiny helper app that relays raw bytes; all protocol logic is in `lib/emdx-ble.mjs`.
* **Showing images** uses Samsung MDC (`set_content_download`, TCP 1515, TLS + PIN) pointing the display at a `content.json` manifest served from this computer.

Run the protocol unit tests with `npm test`.

## References

* [node-samsung-mdc](https://github.com/WeeJeWel/node-samsung-mdc)
* [frontpage](https://github.com/lexdoudkin/frontpage) — EM32DX `content.json` findings (PNG only, escaped slashes, change tokens)
* [Joyous](https://github.com/fayep/Joyous) — original `content.json` reverse engineering
