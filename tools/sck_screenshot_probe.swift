import Cocoa
import ScreenCaptureKit
import UniformTypeIdentifiers

let OUT = "/tmp/souffleur_probe_result.txt"
var log = ""
func emit(_ s: String) { log += s + "\n"; try? log.write(toFile: OUT, atomically: true, encoding: .utf8) }

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let screen = NSScreen.main!
let SF = screen.frame

final class Solid: NSView {
    var c: NSColor = .black
    override func draw(_ r: NSRect) { c.setFill(); r.fill() }
}

func makeWindow(_ color: NSColor, _ idx: CGFloat) -> NSWindow {
    let w: CGFloat = 320, h: CGFloat = 320
    // spread across the lower third, well clear of menu bar
    let rect = NSRect(x: SF.minX + 80 + idx * 380, y: SF.minY + 120, width: w, height: h)
    let win = NSWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
    let v = Solid(frame: NSRect(origin: .zero, size: NSSize(width: w, height: h)))
    v.c = color
    win.contentView = v
    win.backgroundColor = color
    win.isOpaque = true
    win.hasShadow = false
    win.level = .screenSaver              // above modal dialogs, panels, everything normal
    win.ignoresMouseEvents = true
    win.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
    win.orderFrontRegardless()
    return win
}

let magenta = makeWindow(NSColor(srgbRed: 1, green: 0, blue: 1, alpha: 1), 0)
magenta.sharingType = .none                                   // <- legacy flag under test
let cyan    = makeWindow(NSColor(srgbRed: 0, green: 1, blue: 1, alpha: 1), 1)  // <- via excludingWindows
let yellow  = makeWindow(NSColor(srgbRed: 1, green: 1, blue: 0, alpha: 1), 2)  // <- control

// Count how much of THIS window's own rect still shows THIS window's colour.
func fill(_ img: CGImage, _ win: NSWindow, _ match: (UInt8, UInt8, UInt8) -> Bool) -> (hit: Int, area: Int) {
    let sx = CGFloat(img.width) / SF.width
    let sy = CGFloat(img.height) / SF.height
    let f = win.frame
    let left = Int((f.minX - SF.minX) * sx)
    let top  = Int((SF.maxY - f.maxY) * sy)          // flip to top-left origin
    let w    = Int(f.width * sx), h = Int(f.height * sy)

    var data = [UInt8](repeating: 0, count: img.width * img.height * 4)
    guard let ctx = CGContext(data: &data, width: img.width, height: img.height, bitsPerComponent: 8,
                              bytesPerRow: img.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return (0, 0) }
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))

    var hit = 0, area = 0
    let inset = 6                                     // ignore anti-aliased edges
    for y in (top + inset)..<min(top + h - inset, img.height) {
        for x in (left + inset)..<min(left + w - inset, img.width) {
            guard x >= 0, y >= 0 else { continue }
            let i = (y * img.width + x) * 4
            area += 1
            if match(data[i], data[i+1], data[i+2]) { hit += 1 }
        }
    }
    return (hit, area)
}

let isMagenta: (UInt8, UInt8, UInt8) -> Bool = { r, g, b in r > 190 && g < 80 && b > 190 }
let isCyan:    (UInt8, UInt8, UInt8) -> Bool = { r, g, b in r < 80 && g > 190 && b > 190 }
let isYellow:  (UInt8, UInt8, UInt8) -> Bool = { r, g, b in r > 190 && g > 190 && b < 80 }

Task { @MainActor in
    try? await Task.sleep(nanoseconds: 3_000_000_000)
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else { emit("RESULT=NO_DISPLAY"); exit(2) }
        func scw(_ w: NSWindow) -> SCWindow? { content.windows.first { $0.windowID == CGWindowID(w.windowNumber) } }

        emit("macOS=\(ProcessInfo.processInfo.operatingSystemVersionString)")
        emit("screen=\(Int(SF.width))x\(Int(SF.height))  display=\(display.width)x\(display.height)")
        emit("listed: magenta=\(scw(magenta) != nil) cyan=\(scw(cyan) != nil) yellow=\(scw(yellow) != nil)")

        let excluded = [scw(cyan)].compactMap { $0 }
        emit("excludingWindows count=\(excluded.count)")

        let filter = SCContentFilter(display: display, excludingWindows: excluded)
        let cfg = SCStreamConfiguration()
        cfg.width = display.width; cfg.height = display.height; cfg.showsCursor = false
        let shot = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)

        if let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: "\(OUT).png") as CFURL,
                                                      UTType.png.identifier as CFString, 1, nil) {
            CGImageDestinationAddImage(dest, shot, nil); CGImageDestinationFinalize(dest)
        }

        func report(_ name: String, _ win: NSWindow, _ m: @escaping (UInt8, UInt8, UInt8) -> Bool) -> Double {
            let (hit, area) = fill(shot, win, m)
            let pct = area > 0 ? Double(hit) / Double(area) * 100 : -1
            emit(String(format: "%@: %.1f%% of its own rect (%d/%d px)", name, pct, hit, area))
            return pct
        }
        let mPct = report("magenta[sharingType=.none]", magenta, isMagenta)
        let cPct = report("cyan   [excludingWindows]", cyan, isCyan)
        let yPct = report("yellow [control]         ", yellow, isYellow)

        emit("")
        if yPct < 90 { emit("CONTROL=FAILED (\(Int(yPct))%) - something is covering the windows, result invalid") }
        else {
            emit("CONTROL=OK (\(Int(yPct))%)")
            emit("FLAG_sharingTypeNone   = \(mPct > 50 ? "BROKEN - captured" : "WORKS - hidden")")
            emit("API_excludingWindows   = \(cPct > 50 ? "BROKEN - captured" : "WORKS - hidden")")
        }
        emit("DONE")
        exit(0)
    } catch { emit("RESULT=ERROR \(error)"); exit(3) }
}
app.run()
