// AudioTap - dual-source audio capture for Souffleur.
//
// Two independent sources, because they arrive by completely different routes:
//
//   THEM : ScreenCaptureKit system-audio tap. macOS has no loopback device, so
//          this is the only supported way to hear the far side of a call.
//   YOU  : AVAudioEngine on the default input device (the microphone).
//
// They are kept separate rather than mixed. A blended stream cannot tell you
// who said what, and "who asked the question" is most of the value.
//
//   stdout : framed binary, see FRAME below       (nothing else ever)
//   stderr : human-readable status and errors
//
// FRAME
//   offset 0  'V' 'A'                magic
//   offset 2  source                 0 = system, 1 = mic
//   offset 3  reserved               0
//   offset 4  length (uint32 LE)     payload byte count
//   offset 8  payload                s16le mono 16 kHz
//
// Self-test (measures levels, writes nothing to stdout):
//   ./audiotap --selftest 4

import Foundation
import ScreenCaptureKit
import CoreMedia
import AVFoundation

let SAMPLE_RATE = 16000.0
let SRC_SYSTEM: UInt8 = 0
let SRC_MIC: UInt8 = 1

func log(_ s: String) {
    FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
}

// One writer, one lock: two capture callbacks run on different queues and a
// torn frame header would desynchronise the parser for the rest of the session.
final class FrameWriter {
    static let shared = FrameWriter()
    private let lock = NSLock()
    private let out = FileHandle.standardOutput
    var muted = false

    func write(source: UInt8, pcm: UnsafeRawPointer, byteCount: Int) {
        guard !muted, byteCount > 0 else { return }
        var header = Data(capacity: 8)
        header.append(contentsOf: [0x56, 0x41, source, 0])   // 'V','A'
        var len = UInt32(byteCount).littleEndian
        withUnsafeBytes(of: &len) { header.append(contentsOf: $0) }

        lock.lock()
        defer { lock.unlock() }
        out.write(header)
        out.write(Data(bytes: pcm, count: byteCount))
    }
}

/// Running level meter, used only by --selftest.
final class Level {
    private(set) var peak: Float = 0
    private var sumSquares: Double = 0
    private(set) var samples: Int = 0

    func add(_ v: Float) {
        let a = abs(v)
        if a > peak { peak = a }
        sumSquares += Double(v) * Double(v)
        samples += 1
    }
    var db: Double {
        guard samples > 0 else { return -.infinity }
        let rms = (sumSquares / Double(samples)).squareRoot()
        return rms > 0 ? 20 * log10(rms) : -.infinity
    }
}

let systemLevel = Level()
let micLevel = Level()

// The stream MUST be held here, not in the startup block.
//
// SCStream stops capturing the moment it is deallocated. Held only as a local,
// it dies the instant the enclosing scope exits -- which is immediately after
// startCapture() returns. The result is the worst possible failure: the helper
// logs "capturing", exits no error, and delivers zero audio forever. The
// self-test hid this for days because it slept inside that same scope, keeping
// the stream alive for exactly as long as it was being measured.
var activeStream: SCStream?

/* ----------------------------- system audio ------------------------------- */

final class SystemTap: NSObject, SCStreamOutput, SCStreamDelegate {
    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, CMSampleBufferDataIsReady(sb) else { return }

        var blockBuffer: CMBlockBuffer?
        var abl = AudioBufferList()
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sb,
            bufferListSizeNeededOut: nil,
            bufferListOut: &abl,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuffer
        )
        guard status == noErr else { return }

        let list = UnsafeMutableAudioBufferListPointer(&abl)
        guard let buf = list.first, let raw = buf.mData else { return }

        let count = Int(buf.mDataByteSize) / MemoryLayout<Float32>.size
        guard count > 0 else { return }
        let floats = raw.assumingMemoryBound(to: Float32.self)

        var pcm = [Int16](repeating: 0, count: count)
        for i in 0..<count {
            let v = max(-1.0, min(1.0, floats[i]))
            pcm[i] = Int16(v * 32767.0)
            systemLevel.add(v)
        }
        pcm.withUnsafeBufferPointer { p in
            guard let base = p.baseAddress else { return }
            FrameWriter.shared.write(source: SRC_SYSTEM, pcm: base,
                                     byteCount: count * MemoryLayout<Int16>.size)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        log("system audio stopped: \(error.localizedDescription)")
    }
}

/* --------------------------------- mic ------------------------------------ */

final class MicTap {
    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private let target = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                       sampleRate: SAMPLE_RATE,
                                       channels: 1,
                                       interleaved: true)!

    func start() throws {
        let input = engine.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.sampleRate > 0 else {
            throw NSError(domain: "souffleur", code: 10, userInfo: [
                NSLocalizedDescriptionKey: "no usable input device",
            ])
        }
        guard let conv = AVAudioConverter(from: inFormat, to: target) else {
            throw NSError(domain: "souffleur", code: 11, userInfo: [
                NSLocalizedDescriptionKey: "cannot convert \(inFormat) to 16 kHz mono",
            ])
        }
        converter = conv

        input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { [weak self] buffer, _ in
            self?.handle(buffer, from: inFormat)
        }
        engine.prepare()
        try engine.start()
        log("mic capture started (device format \(Int(inFormat.sampleRate)) Hz, \(inFormat.channelCount) ch)")
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    private func handle(_ buffer: AVAudioPCMBuffer, from inFormat: AVAudioFormat) {
        guard let converter else { return }

        let ratio = target.sampleRate / inFormat.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }

        var supplied = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        if let error {
            log("mic conversion failed: \(error.localizedDescription)")
            return
        }

        let frames = Int(out.frameLength)
        guard frames > 0, let channel = out.int16ChannelData?[0] else { return }

        for i in 0..<frames { micLevel.add(Float(channel[i]) / 32768.0) }
        FrameWriter.shared.write(source: SRC_MIC, pcm: channel,
                                 byteCount: frames * MemoryLayout<Int16>.size)
    }
}

/* -------------------------------- startup --------------------------------- */

let args = CommandLine.arguments
let selftest = args.contains("--selftest")
let wantMic = args.contains("--mic")   // speaker audio is the point; mic is opt-in
let wantSystem = !args.contains("--no-system")
let seconds: Double = {
    if let i = args.firstIndex(of: "--selftest"), i + 1 < args.count,
       let v = Double(args[i + 1]) { return v }
    return 4
}()

guard #available(macOS 13.0, *) else {
    log("ScreenCaptureKit audio capture needs macOS 13 or newer.")
    exit(2)
}

FrameWriter.shared.muted = selftest
let systemTap = SystemTap()
var micTap: MicTap?

/// Mic access is a separate TCC permission from screen recording; ask for it
/// explicitly so the prompt appears instead of the engine silently going quiet.
func requestMic() async -> Bool {
    if AVCaptureDevice.authorizationStatus(for: .audio) == .authorized { return true }
    return await AVCaptureDevice.requestAccess(for: .audio)
}

Task {
    var started: [String] = []

    if wantMic {
        if await requestMic() {
            do {
                let m = MicTap()
                try m.start()
                micTap = m
                started.append("mic")
            } catch {
                log("mic unavailable: \(error.localizedDescription)")
            }
        } else {
            log("mic permission denied - your own voice will not be transcribed")
        }
    }

    if wantSystem {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let display = content.displays.first else {
                log("no display available for system audio")
                exit(3)
            }
            let config = SCStreamConfiguration()
            config.capturesAudio = true
            config.sampleRate = Int(SAMPLE_RATE)
            config.channelCount = 1
            config.excludesCurrentProcessAudio = true   // never hear ourselves
            config.width = 2                            // video is required, so keep it minimal
            config.height = 2
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            config.showsCursor = false
            config.queueDepth = 5

            let filter = SCContentFilter(display: display, excludingWindows: [])
            let stream = SCStream(filter: filter, configuration: config, delegate: systemTap)
            try stream.addStreamOutput(systemTap, type: .audio,
                                       sampleHandlerQueue: DispatchQueue(label: "souffleur.system"))
            try await stream.startCapture()
            activeStream = stream       // keep it alive past this scope
            started.append("system")

            if selftest {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                try? await stream.stopCapture()
                activeStream = nil
                micTap?.stop()
                log(String(format: "system: samples=%d peak=%.4f rms=%.1f dBFS",
                           systemLevel.samples, systemLevel.peak, systemLevel.db))
                log(String(format: "mic:    samples=%d peak=%.4f rms=%.1f dBFS",
                           micLevel.samples, micLevel.peak, micLevel.db))
                log("RESULT system=\(systemLevel.samples > 0 ? (systemLevel.db > -70 ? "AUDIO" : "SILENT") : "NONE")" +
                    " mic=\(micLevel.samples > 0 ? (micLevel.db > -70 ? "AUDIO" : "SILENT") : "NONE")")
                exit(0)
            }
        } catch {
            log("system audio failed: \(error.localizedDescription)")
            if started.isEmpty { exit(1) }
        }
    }

    if started.isEmpty {
        log("no audio source available")
        exit(1)
    }
    log("capturing: \(started.joined(separator: " + ")) at \(Int(SAMPLE_RATE)) Hz mono")
}

signal(SIGPIPE, SIG_IGN)   // parent closing the pipe is our shutdown signal
RunLoop.main.run()
