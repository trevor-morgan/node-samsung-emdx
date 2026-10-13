# EMDX Bluetooth setup protocol

How a Samsung EMDX Color E-Paper display (tested on an EM32DX, firmware
S-RSEDWWC-1061.0) is joined to Wi-Fi over Bluetooth LE. Worked out for
interoperability by studying Samsung's E-Paper Android app (1.3.3) and
confirmed against a real display. Implemented in `lib/emdx-ble.mjs`.

## Transport

| item | value |
| --- | --- |
| Advertised name | `Samsung EM32DX <suffix>` |
| Manufacturer data | Samsung, company `0x0075`; payload byte 1 = `0x22` marks an e-paper display |
| Setup service | `53564344-6576-6963-6553-657474696E67` (ASCII "SVCDeviceSetting") |
| Command characteristic | `434D4444-6576-6963-6553-657474696E67` ("CMDDeviceSetting"), write-with-response + indicate |

* The setup service is only exposed while the display is in **Bluetooth pairing
  mode** (hold the Bluetooth button until the blue light blinks). Outside it,
  only an IoTivity/OCF CoAP service (`ADE3D529-…`) is visible.
* The command characteristic advertises *indicate* but has **no CCCD**; enabling
  indications fails, yet replies are delivered anyway. Ignore the error.
* The first authorization write makes the OS bond with the display ("Just
  Works", no prompt). The display discards the bond after the session, so the
  central must delete its copy before reconnecting — on macOS via System
  Settings → Bluetooth → Forget This Device, otherwise the next connection fails
  with "Peer removed pairing information".
* One request at a time: write, then wait for the next indication.

## Frames

Requests and replies share a 2-byte header:

```
byte 0  (id << 6) | (fragment << 5) | (more << 4) | (op << 1) | (len >> 8)
byte 1  len & 0xff          len = 1 (command id) + payload length
```

Requests: `header | command id | payload`, always `id = 0`.
Operation types: `0` request-with-response (settings), `7` authorization.
Payloads larger than the MTU are split into fragments carrying a 4-byte
big-endian total/offset field; with macOS's 512-byte MTU this never happens
during setup.

Replies:

* authorization: `header | command id | data`
* everything else: `header | status (low 6 bits) | command id | data`

Status codes: `0` success, `33` error, `36` PID exists, `37` not supported,
`38` invalid data, `39` API error, `41` fragment error, `63` command-defined error.

## Authorization (PIN)

1. Send start-authorization: op 7, command `0x01`, empty payload (`0e 01 01`).
2. Reply data: byte 0 = `version << 5 | cost`, then a 16-byte salt.
   Version 0/1/2/3 select bcrypt `2a`/`2x`/`2y`/`2b` (identical for digit PINs).
3. Compute bcrypt(cost, salt, PIN) on the 6 ASCII digits, take the 31-character
   hash part of the bcrypt string and decode it with bcrypt's base64 alphabet:
   23 bytes.
4. Send answer-authorization: op 7, command `0x04`, payload = those 23 bytes.
5. Reply data byte 0: `0` success, `1` already authorized, `128` denied,
   `129` invalid sequence, `130` wrong PIN.

The PIN is shown on the display and changes whenever pairing mode starts. The
same PIN authenticates Samsung MDC on TCP 1515 afterwards.

## Commands used for Wi-Fi setup (op 0)

| step | command | payload |
| --- | --- | --- |
| wired/PoE mode off (then wait 3 s) | `0x18` | `00` (may answer "not supported") |
| network type = Wi-Fi | `0x11` | `01` (`00` = wired) |
| Wi-Fi credentials | `0x14` | `0x40 \| len(ssid)`, SSID, `len(password)`, password (UTF-8, plaintext). Open network: `len(ssid)`, SSID |
| automatic IP (DHCP) | `0x12` | `C0` + 12 × `00` |
| read IP | `0x12` | empty |

The address reply is 13 bytes: byte 0 = `dhcp << 7 | autoDns << 6 | prefix`,
then IPv4 address, gateway and DNS (4 bytes each). The credentials payload has
no security-type field; the display picks WPA2/WPA3 from its own scan.

Read-only helpers: `0x10` device status (1 bit field byte; bit 0 = setup done),
`0x14` with an empty payload returns the configured SSID, `0x18` empty = PoE state.
