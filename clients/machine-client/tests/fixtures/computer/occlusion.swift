import AppKit
import Darwin

final class Pattern: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor.red.setFill()
        bounds.fill()
        NSColor.green.setFill()
        NSRect(x: bounds.midX, y: 0, width: bounds.width / 2, height: bounds.height).fill()
    }
}

final class Delegate: NSObject, NSApplicationDelegate {
    var windows: [NSWindow] = []
    func applicationDidFinishLaunching(_ notification: Notification) {
        let frame = NSRect(x: 100, y: 100, width: 320, height: 240)
        let target = NSWindow(contentRect: frame, styleMask: [.titled], backing: .buffered, defer: false)
        target.title = "Oni capture target"
        target.contentView = Pattern(frame: NSRect(origin: .zero, size: frame.size))
        target.orderFrontRegardless()
        let cover = NSWindow(contentRect: frame, styleMask: [.titled], backing: .buffered, defer: false)
        cover.title = "Oni capture cover"
        cover.backgroundColor = .blue
        cover.orderFrontRegardless()
        windows = [target, cover]
        DispatchQueue.main.async {
            target.display()
            cover.display()
            let fd = socket(AF_UNIX, SOCK_STREAM, 0)
            var address = sockaddr_un()
            address.sun_family = sa_family_t(AF_UNIX)
            let path = CommandLine.arguments[1]
            withUnsafeMutableBytes(of: &address.sun_path) { destination in
                path.utf8CString.withUnsafeBytes { source in
                    destination.copyBytes(from: source)
                }
            }
            let result = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            if result == 0 {
                var ready: UInt8 = 1
                _ = write(fd, &ready, 1)
            }
            close(fd)
        }
    }
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let delegate = Delegate()
application.delegate = delegate
application.run()
