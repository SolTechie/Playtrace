import AppKit

@main struct Icon {
    static func main() throws {
        let folder = URL(fileURLWithPath: CommandLine.arguments[1])
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for size in [16, 32, 128, 256, 512] {
            for scale in [1, 2] {
                let pixels = size * scale
                let image = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: image)
                let p = CGFloat(pixels)
                NSColor(calibratedRed: 178/255, green: 237/255, blue: 117/255, alpha: 1).setFill()
                NSBezierPath(roundedRect: NSRect(x: p * 0.09, y: p * 0.09, width: p * 0.82, height: p * 0.82), xRadius: p * 0.18, yRadius: p * 0.18).fill()
                let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: p * 0.65, weight: .heavy), .foregroundColor: NSColor(calibratedRed: 22/255, green: 32/255, blue: 17/255, alpha: 1)]
                let text = NSString(string: "P")
                let extent = text.size(withAttributes: attributes)
                text.draw(at: NSPoint(x: (p - extent.width)/2, y: (p - extent.height)/2 + p * 0.02), withAttributes: attributes)
                NSGraphicsContext.restoreGraphicsState()
                let name = "icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"
                try image.representation(using: .png, properties: [:])!.write(to: folder.appendingPathComponent(name))
            }
        }
    }
}
