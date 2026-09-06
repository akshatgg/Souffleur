// MakeIcon - draws the app icon.
//
// The mark is the souffleur's box: the low dome set into the front of a stage,
// with the prompter hidden inside it feeding lines the audience never hears.
// A dome reads at 32px and is not another chat bubble, eye or speech balloon.
//
//   swift build/MakeIcon.swift && ./MakeIcon build/icon.png

import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"

let cs = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                          bytesPerRow: 0, space: cs,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    fatalError("no context")
}

let S = CGFloat(size)
func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor {
    CGColor(colorSpace: cs, components: [r/255, g/255, b/255, a])!
}

// Rounded-square ground, cold graphite rather than tinted black.
let radius = S * 0.2237                       // macOS squircle proportion
let plate = CGPath(roundedRect: CGRect(x: 0, y: 0, width: S, height: S),
                   cornerWidth: radius, cornerHeight: radius, transform: nil)
ctx.addPath(plate)
ctx.clip()

if let bg = CGGradient(colorsSpace: cs,
                       colors: [rgb(31, 37, 48), rgb(14, 17, 23)] as CFArray,
                       locations: [0, 1]) {
    ctx.drawLinearGradient(bg, start: CGPoint(x: 0, y: S), end: CGPoint(x: 0, y: 0), options: [])
}

// The stage floor.
let floorY = S * 0.395
ctx.setStrokeColor(rgb(255, 255, 255, 0.16))
ctx.setLineWidth(S * 0.014)
ctx.move(to: CGPoint(x: S * 0.10, y: floorY))
ctx.addLine(to: CGPoint(x: S * 0.90, y: floorY))
ctx.strokePath()

// Light spilling out of the box, upward onto the stage.
// Low and wide: the box is a shallow shell set into the stage front, not an
// egg. Height is the *visible* half, so the ellipse is drawn at twice that.
let domeW = S * 0.60
let domeH = S * 0.225
let domeRect = CGRect(x: (S - domeW) / 2, y: floorY, width: domeW, height: domeH * 2)

ctx.saveGState()
ctx.addRect(CGRect(x: 0, y: floorY, width: S, height: S - floorY))
ctx.clip()
if let glow = CGGradient(colorsSpace: cs,
                         colors: [rgb(242, 200, 120, 0.30), rgb(242, 200, 120, 0)] as CFArray,
                         locations: [0, 1]) {
    ctx.drawRadialGradient(glow,
                           startCenter: CGPoint(x: S / 2, y: floorY), startRadius: 0,
                           endCenter: CGPoint(x: S / 2, y: floorY), endRadius: S * 0.34,
                           options: [])
}
ctx.restoreGState()

// The dome itself: a half-ellipse sitting on the floor line.
let dome = CGMutablePath()
dome.addEllipse(in: domeRect)
ctx.saveGState()
ctx.addRect(CGRect(x: 0, y: floorY, width: S, height: S - floorY))
ctx.clip()

ctx.addPath(dome)
ctx.setFillColor(rgb(11, 14, 19))
ctx.fillPath()

ctx.addPath(dome)
ctx.setStrokeColor(rgb(242, 200, 120))
ctx.setLineWidth(S * 0.030)
ctx.strokePath()
ctx.restoreGState()

// The prompter inside: one warm slot of light in the mouth of the box.
let slotW = domeW * 0.30
let slotH = S * 0.045
let slot = CGPath(roundedRect: CGRect(x: (S - slotW) / 2, y: floorY + S * 0.045,
                                      width: slotW, height: slotH),
                  cornerWidth: slotH / 2, cornerHeight: slotH / 2, transform: nil)
ctx.addPath(slot)
ctx.setFillColor(rgb(242, 200, 120))
ctx.fillPath()

guard let image = ctx.makeImage() else { fatalError("no image") }
let url = URL(fileURLWithPath: out)
guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    fatalError("no destination")
}
CGImageDestinationAddImage(dest, image, nil)
CGImageDestinationFinalize(dest)
print("wrote \(out) at \(size)x\(size)")
