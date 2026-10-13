// EMDXBridge: a minimal Bluetooth LE bridge between Node.js and a Samsung EMDX
// e-paper display on macOS.
//
// macOS only lets an app bundle with an NSBluetoothAlwaysUsageDescription use
// Bluetooth, so the Node CLI launches this bundle with `open` and talks to it
// through two files:
//
//   argv[1]  command file: Node appends one command per line; this app polls it.
//   stdout   event stream: one event per line (redirected to a file by `open --stdout`).
//   argv[2]  optional device-name filter (default "EMDX"; also matches "EM32DX"/"EM13DX").
//
// Pairing note: the display bonds silently during the PIN handshake and drops
// its side of the bond after each session, so the bond macOS keeps makes the
// next connection fail with "Peer removed pairing information". There is no
// working programmatic unpair for Bluetooth LE on current macOS (IOBluetooth's
// `remove` and CoreBluetooth's private `unpairPeer:` are both ignored), so the
// Node CLI tells the user to use System Settings > Bluetooth > Forget This Device.
//
// Commands:  sub <char-uuid> | write <char-uuid> <hex> | read <char-uuid> | quit
// Events:    SEEN ... | READY <name> mtu=<n> services=<uuid,...>
//            SUB <uuid> ok|err <msg> | WROTE <uuid> ok|err <msg> | RX <uuid> <hex>
//            READ <uuid> <hex>|err <msg> | NOTFOUND | ERR <msg> | DISCONNECTED <reason>
// The bridge never interprets payloads; all protocol logic lives in Node.
import CoreBluetooth
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ line: String) { print(line) }

func hex(_ d: Data?) -> String {
    guard let d = d else { return "" }
    return d.map { String(format: "%02x", $0) }.joined()
}

func parseHex(_ s: String) -> Data? {
    guard s.count % 2 == 0 else { return nil }
    var out = Data(capacity: s.count / 2)
    var i = s.startIndex
    while i < s.endIndex {
        let j = s.index(i, offsetBy: 2)
        guard let b = UInt8(s[i..<j], radix: 16) else { return nil }
        out.append(b)
        i = j
    }
    return out
}

final class Bridge: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private let commandPath: String
    private let nameFilter: String
    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var pendingServices = 0
    private var ready = false
    private var commandOffset: UInt64 = 0
    private var partialLine = ""
    private var queue: [[String]] = []
    private var busy = false
    private var pendingRead: CBUUID?
    private var seen = Set<UUID>()

    init(commandPath: String, nameFilter: String) {
        self.commandPath = commandPath
        self.nameFilter = nameFilter.uppercased()
        super.init()
        central = CBCentralManager(delegate: self, queue: nil)
    }

    // MARK: connection

    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        switch c.state {
        case .poweredOn:
            c.scanForPeripherals(withServices: nil, options: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
                if self?.peripheral == nil { emit("NOTFOUND"); exit(3) }
            }
        case .unauthorized: emit("ERR bluetooth permission denied"); exit(2)
        case .poweredOff: emit("ERR bluetooth is off"); exit(2)
        default: break
        }
    }

    /// Matches the display by advertised name, e.g. "Samsung EM32DX 1A2B".
    private func matches(_ name: String) -> Bool {
        let n = name.uppercased()
        return n.contains(nameFilter) || n.contains("EM32DX") || n.contains("EM13DX") || n.contains("EMDX")
    }

    /// Samsung (company 0x0075) manufacturer data with byte[1] == 0x22 marks an
    /// e-paper display, even in advertisements that carry no name.
    private func isEpaperAdvert(_ ad: [String: Any]) -> Bool {
        guard let m = ad[CBAdvertisementDataManufacturerDataKey] as? Data, m.count >= 4 else { return false }
        let b = [UInt8](m)
        return b[0] == 0x75 && b[1] == 0x00 && b[3] == 0x22
    }

    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral,
                        advertisementData ad: [String: Any], rssi: NSNumber) {
        let name = (ad[CBAdvertisementDataLocalNameKey] as? String) ?? p.name ?? ""
        let epaper = isEpaperAdvert(ad)
        if (epaper || matches(name)) && !seen.contains(p.identifier) {
            seen.insert(p.identifier)
            let mfr = (ad[CBAdvertisementDataManufacturerDataKey] as? Data).map { hex($0) } ?? "-"
            emit("SEEN name=\"\(name)\" rssi=\(rssi) mfr=\(mfr) connectable=\(ad[CBAdvertisementDataIsConnectable] ?? "?")")
        }
        guard peripheral == nil, matches(name) || epaper else { return }
        peripheral = p
        c.stopScan()
        c.connect(p, options: nil)
    }

    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
        p.delegate = self
        p.discoverServices(nil)
    }

    func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        emit("ERR connect failed: \(error?.localizedDescription ?? "unknown")")
        finish(p, code: 4)
    }

    func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        emit("DISCONNECTED \(error?.localizedDescription ?? "clean")")
        finish(p, code: 0)
    }

    private func finish(_ p: CBPeripheral, code: Int32) {
        exit(code)
    }

    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        let services = p.services ?? []
        pendingServices = services.count
        if services.isEmpty {
            emit("ERR no services")
            central.cancelPeripheralConnection(p)
            return
        }
        for s in services { p.discoverCharacteristics(nil, for: s) }
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor s: CBService, error: Error?) {
        pendingServices -= 1
        guard pendingServices == 0, !ready else { return }
        ready = true
        let services = (p.services ?? []).map { $0.uuid.uuidString }.joined(separator: ",")
        emit("READY \(p.name ?? "?") mtu=\(p.maximumWriteValueLength(for: .withResponse)) services=\(services)")
        Timer.scheduledTimer(withTimeInterval: 0.03, repeats: true) { [weak self] _ in self?.pollCommands() }
    }

    // MARK: commands

    private func characteristic(_ uuid: String) -> CBCharacteristic? {
        let want = CBUUID(string: uuid)
        return peripheral?.services?.flatMap { $0.characteristics ?? [] }.first { $0.uuid == want }
    }

    /// Reads any newly appended lines from the command file and queues them.
    private func pollCommands() {
        guard let fh = FileHandle(forReadingAtPath: commandPath) else { return }
        defer { try? fh.close() }
        try? fh.seek(toOffset: commandOffset)
        let data = fh.readDataToEndOfFile()
        guard !data.isEmpty else { return }
        commandOffset += UInt64(data.count)
        partialLine += String(decoding: data, as: UTF8.self)
        while let nl = partialLine.firstIndex(of: "\n") {
            let line = partialLine[..<nl].trimmingCharacters(in: .whitespaces)
            partialLine = String(partialLine[partialLine.index(after: nl)...])
            if !line.isEmpty { queue.append(line.split(separator: " ").map(String.init)) }
        }
        runNext()
    }

    /// Runs queued commands one at a time; writes wait for the ATT write response.
    private func runNext() {
        guard !busy, !queue.isEmpty, let p = peripheral else { return }
        let cmd = queue.removeFirst()
        switch cmd[0] {
        case "quit":
            central.cancelPeripheralConnection(p)
        case "sub":
            guard cmd.count == 2, let ch = characteristic(cmd[1]) else { emit("ERR no characteristic \(cmd.dropFirst().joined())"); return runNext() }
            busy = true
            p.setNotifyValue(true, for: ch)
        case "write":
            guard cmd.count == 3, let ch = characteristic(cmd[1]), let data = parseHex(cmd[2]) else {
                emit("ERR bad write \(cmd.dropFirst().joined(separator: " "))"); return runNext()
            }
            busy = true
            p.writeValue(data, for: ch, type: .withResponse)
        case "read":
            guard cmd.count == 2, let ch = characteristic(cmd[1]) else { emit("ERR no characteristic \(cmd.dropFirst().joined())"); return runNext() }
            busy = true
            pendingRead = ch.uuid
            p.readValue(for: ch)
        default:
            emit("ERR unknown command \(cmd[0])"); runNext()
        }
    }

    private func done() { busy = false; runNext() }

    // MARK: peripheral callbacks

    func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor ch: CBCharacteristic, error: Error?) {
        emit("SUB \(ch.uuid.uuidString) " + (error.map { "err \($0.localizedDescription)" } ?? "ok"))
        done()
    }

    func peripheral(_ p: CBPeripheral, didWriteValueFor ch: CBCharacteristic, error: Error?) {
        emit("WROTE \(ch.uuid.uuidString) " + (error.map { "err \($0.localizedDescription)" } ?? "ok"))
        done()
    }

    func peripheral(_ p: CBPeripheral, didUpdateValueFor ch: CBCharacteristic, error: Error?) {
        // The EMDX command characteristic has no CCCD, so its indications arrive
        // without a successful subscription; anything that is not the answer to
        // an explicit `read` is an incoming RX event.
        if let want = pendingRead, ch.uuid == want {
            pendingRead = nil
            emit("READ \(ch.uuid.uuidString) " + (error.map { "err \($0.localizedDescription)" } ?? hex(ch.value)))
            done()
        } else if let error = error {
            emit("ERR rx \(ch.uuid.uuidString) \(error.localizedDescription)")
        } else {
            emit("RX \(ch.uuid.uuidString) \(hex(ch.value))")
        }
    }
}

let args = CommandLine.arguments
guard args.count >= 2 else { emit("ERR usage: EMDXBridge <command-file> [name-filter]"); exit(1) }
let bridge = Bridge(commandPath: args[1], nameFilter: args.count > 2 ? args[2] : "EMDX")
// Safety net: never linger in the background for more than 15 minutes.
DispatchQueue.main.asyncAfter(deadline: .now() + 900) { emit("ERR session timeout"); exit(5) }
RunLoop.main.run()
