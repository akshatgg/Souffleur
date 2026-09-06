import Cocoa
import ScreenCaptureKit
import CoreMedia

let OUT = "/tmp/souffleur_stream_result.txt"
var log = ""
func emit(_ s: String) { log += s + "\n"; try? log.write(toFile: OUT, atomically: true, encoding: .utf8); }

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let screen = NSScreen.main!
let SF = screen.frame

final class Solid: NSView {
    var c: NSColor = .black
    override func draw(_ r: NSRect) { c.setFill(); r.fill() }
}
func mk(_ color: NSColor, _ i: CGFloat) -> NSWindow {
    let s: CGFloat = 320
    let win = NSWindow(contentRect: NSRect(x: SF.minX + 80 + i*380, y: SF.minY + 120, width: s, height: s),
                       styleMask: [.borderless], backing: .buffered, defer: false)
    let v = Solid(frame: NSRect(x: 0, y: 0, width: s, height: s)); v.c = color
    win.contentView = v; win.backgroundColor = color; win.isOpaque = true; win.hasShadow = false
    win.level = .screenSaver; win.ignoresMouseEvents = true
    win.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
    win.orderFrontRegardless()
    return win
}
let magenta = mk(NSColor(srgbRed: 1, green: 0, blue: 1, alpha: 1), 0); magenta.sharingType = .none
let cyan    = mk(NSColor(srgbRed: 0, green: 1, blue: 1, alpha: 1), 1)
let yellow  = mk(NSColor(srgbRed: 1, green: 1, blue: 0, alpha: 1), 2)

// worst-case (max) leak seen across every frame of the stream
var worst: [String: Double] = ["magenta": 0, "cyan": 0, "yellow": 0]
var frames = 0

final class Out: NSObject, SCStreamOutput, SCStreamDelegate {
    func stream(_ s: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of t: SCStreamOutputType) {
        guard t == .screen, let px = CMSampleBufferGetImageBuffer(sb) else { return }
        CVPixelBufferLockBaseAddress(px, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(px, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(px) else { return }
        let bpr = CVPixelBufferGetBytesPerRow(px)
        if frames == 0 {
            let fmt = CVPixelBufferGetPixelFormatType(px)
            let cc = String(bytes: [UInt8((fmt >> 24) & 255), UInt8((fmt >> 16) & 255),
                                    UInt8((fmt >> 8) & 255), UInt8(fmt & 255)], encoding: .ascii) ?? "?"
            emit("buffer=\(CVPixelBufferGetWidth(px))x\(CVPixelBufferGetHeight(px)) bpr=\(bpr) fmt=\(cc) planes=\(CVPixelBufferGetPlaneCount(px))")
            emit("screenFrame=\(SF)")
            let yf = yellow.frame
            emit("yellowFrame=\(yf)")
        }
        let W = CVPixelBufferGetWidth(px), H = CVPixelBufferGetHeight(px)
        let buf = base.assumingMemoryBound(to: UInt8.self)
        let sx = CGFloat(W) / SF.width, sy = CGFloat(H) / SF.height

        func measure(_ win: NSWindow, _ m: (UInt8, UInt8, UInt8) -> Bool) -> Double {
            let f = win.frame
            let l = Int((f.minX - SF.minX) * sx) + 8
            let tp = Int((SF.maxY - f.maxY) * sy) + 8
            let w = Int(f.width * sx) - 16, h = Int(f.height * sy) - 16
            var hit = 0, tot = 0
            var y = tp
            while y < min(tp + h, H) {
                var x = l
                while x < min(l + w, W) {
                    if x >= 0 && y >= 0 {
                        let o = y * bpr + x * 4          // BGRA
                        tot += 1
                        if m(buf[o+2], buf[o+1], buf[o]) { hit += 1 }
                    }
                    x += 4
                }
                y += 4
            }
            return tot > 0 ? Double(hit)/Double(tot)*100 : 0
        }
        if frames == 0 {
            let f = yellow.frame
            let cx = Int((f.midX - SF.minX) * sx), cy = Int((SF.maxY - f.midY) * sy)
            if cx >= 0, cy >= 0, cx < W, cy < H {
                let o = cy * bpr + cx * 4
                emit("yellow centre px at (\(cx),\(cy)) bytes=[\(buf[o]),\(buf[o+1]),\(buf[o+2]),\(buf[o+3])]")
            } else { emit("yellow centre (\(cx),\(cy)) OUT OF BOUNDS for \(W)x\(H)") }
        }
        let mp = measure(magenta) { r,g,b in r > 180 && b > 180 && Int(g) < Int(min(r,b)) - 80 }
        let cp = measure(cyan)    { r,g,b in g > 180 && b > 180 && Int(r) < Int(min(g,b)) - 80 }
        let yp = measure(yellow)  { r,g,b in r > 180 && g > 180 && Int(b) < Int(min(r,g)) - 80 }
        worst["magenta"] = max(worst["magenta"]!, mp)
        worst["cyan"]    = max(worst["cyan"]!,    cp)
        worst["yellow"]  = max(worst["yellow"]!,  yp)
        frames += 1
    }
    func stream(_ s: SCStream, didStopWithError e: Error) { emit("STREAM_ERROR \(e)") }
}

let out = Out()
Task { @MainActor in
    try? await Task.sleep(nanoseconds: 2_000_000_000)
    do {
        let c = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let d = c.displays.first else { emit("NO_DISPLAY"); exit(2) }
        let excl = c.windows.filter { $0.windowID == CGWindowID(cyan.windowNumber) }
        let filter = SCContentFilter(display: d, excludingWindows: excl)
        let cfg = SCStreamConfiguration()
        cfg.width = d.width; cfg.height = d.height
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        cfg.showsCursor = false
        cfg.queueDepth = 6

        let stream = SCStream(filter: filter, configuration: cfg, delegate: out)
        try stream.addStreamOutput(out, type: .screen,
                                   sampleHandlerQueue: DispatchQueue(label: "cap"))
        try await stream.startCapture()
        emit("streaming for 5s at 30fps (this is the path Zoom/Meet/Teams actually use)...")
        try? await Task.sleep(nanoseconds: 5_000_000_000)
        try? await stream.stopCapture()

        emit("frames analysed=\(frames)")
        emit(String(format: "WORST magenta[sharingType=.none] = %.2f%%", worst["magenta"]!))
        emit(String(format: "WORST cyan   [excludingWindows]  = %.2f%%", worst["cyan"]!))
        emit(String(format: "WORST yellow [control]           = %.2f%%", worst["yellow"]!))
        emit("")
        if worst["yellow"]! < 90 { emit("CONTROL=FAILED - invalid test") }
        else {
            emit("CONTROL=OK")
            emit("FLAG_sharingTypeNone = \(worst["magenta"]! > 5 ? "LEAKS" : "HIDDEN in every frame")")
            emit("API_excludingWindows = \(worst["cyan"]!    > 5 ? "LEAKS" : "HIDDEN in every frame")")
        }
        emit("DONE")
        exit(0)
    } catch { emit("ERROR \(error)"); exit(3) }
}
app.run()
