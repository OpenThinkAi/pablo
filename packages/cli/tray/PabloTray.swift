// The pablo menu-bar helper — AGT-1256.
//
// pablo has no screen, and today the only sign a piece pablo wrote is waiting
// for a decision is whatever the driving agent happens to say in chat. This
// puts one small signal on the Mac itself: a glyph that sits quiet while
// nothing is waiting and lights up in full colour the moment something is.
//
// It is a *reader*, on the same design as insieme's tray/InsiemeTray.swift. No
// credential, no network request, no prose ever read. Everything it shows
// comes out of one JSON file the daemon rewrites (`tray-state.json`), which
// carries titles and word counts only (see review-tray.md, "The tray"). A
// click can ask for exactly two things, Approve or Review…, both the same
// parcel-then-SIGUSR1 shape as insieme's askForWorksheet: a small file dropped
// beside the state file, then a signal. The helper decides nothing and execs
// nothing.
//
// The daemon spawns this as a child and never has to clean it up: `getppid()`
// is polled, and the moment it changes — the parent exited — the helper
// terminates. Compiled by plain `swiftc`, one file, no Xcode project.

import AppKit
import Foundation

// MARK: - the state file

/// One piece waiting on a decision — a title and a count, never prose.
struct PendingPiece {
    let id: String
    let kind: String
    let title: String
    let words: Int
    let at: String
}

struct TrayState {
    var daemonPid: Int32 = 0
    var version: String = ""
    var pending: [PendingPiece] = []
    var lastError: String = ""

    /// Parse the daemon's file, or fall back to "nothing waiting".
    ///
    /// A missing or malformed file renders as empty pending (AC 1) — a helper
    /// that raised an alert over a half-written rename would be worse than one
    /// that briefly shows a quiet icon.
    static func read(_ path: String) -> TrayState {
        var state = TrayState()
        guard
            let data = FileManager.default.contents(atPath: path),
            let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return state }

        if let pid = root["daemonPid"] as? Int, pid >= Int(Int32.min), pid <= Int(Int32.max) {
            state.daemonPid = Int32(pid)
        }
        if let version = root["version"] as? String { state.version = version }
        if let lastError = root["lastError"] as? String { state.lastError = lastError }
        if let rawPending = root["pending"] as? [[String: Any]] {
            state.pending = rawPending.compactMap { item in
                guard
                    let id = item["id"] as? String,
                    let kind = item["kind"] as? String,
                    let title = item["title"] as? String,
                    let at = item["at"] as? String
                else { return nil }
                let words = (item["words"] as? Int) ?? 0
                return PendingPiece(id: id, kind: kind, title: title, words: words, at: at)
            }
        }
        return state
    }
}

// MARK: - the dropdown, as a value

/// What a click on a piece's submenu does.
enum TrayAction: String {
    case approve
    case review
}

/// One row of the dropdown, as a plain value with no AppKit in it.
///
/// The point, as in insieme: `menuEntries(for:)` can be printed by `--menu` and
/// asserted by `test:tray` without a status item existing anywhere, and
/// `buildMenu()` becomes a rendering step with no decisions left in it.
indirect enum MenuEntry: Equatable {
    /// Shown, never clickable.
    case label(String)
    /// Shown and clickable — title, what it asks for, and which piece.
    case action(String, TrayAction, String)
    case separator
    /// A titled row that opens its own children, one per pending piece.
    case submenu(String, [MenuEntry])
}

/// The dropdown — AC 3. A disabled line when nothing waits; otherwise one
/// submenu per pending piece, newest first, at most five, each holding Approve
/// and Review…. Then an optional error line, a separator, and the version.
func menuEntries(for state: TrayState) -> [MenuEntry] {
    var entries: [MenuEntry] = []

    if state.pending.isEmpty {
        entries.append(.label("Nothing waiting"))
    } else {
        let newestFirst = state.pending.sorted { $0.at > $1.at }
        for piece in newestFirst.prefix(5) {
            let title = "\"\(piece.title)\" · \(piece.words) words · \(piece.kind)"
            entries.append(
                .submenu(title, [
                    .action("Approve", .approve, piece.id),
                    .action("Review…", .review, piece.id),
                ])
            )
        }
    }

    if !state.lastError.isEmpty {
        entries.append(.label(state.lastError))
    }

    entries.append(.separator)
    entries.append(.label(versionLine(for: state)))
    return entries
}

func versionLine(for state: TrayState) -> String {
    state.version.isEmpty ? "pablo" : "pablo \(state.version)"
}

/// What `--menu` prints: one line per entry, a submenu's children indented two
/// spaces under it. This is the test contract — keep it stable and boring.
func renderMenu(_ entries: [MenuEntry]) -> String {
    var lines: [String] = []
    for entry in entries { appendRendered(entry, indent: "", into: &lines) }
    return lines.joined(separator: "\n") + "\n"
}

private func appendRendered(_ entry: MenuEntry, indent: String, into lines: inout [String]) {
    switch entry {
    case .label(let title):
        lines.append("\(indent)label: \(title)")
    case .action(let title, let action, let id):
        lines.append("\(indent)action: \(title) [\(action.rawValue) \(id)]")
    case .separator:
        lines.append("\(indent)separator")
    case .submenu(let title, let children):
        lines.append("\(indent)submenu: \(title)")
        for child in children { appendRendered(child, indent: indent + "  ", into: &lines) }
    }
}

// MARK: - the click: parcel, then bell

/// Approve or Review…, on a piece — AC 4.
///
/// Written temp-then-rename at 0600, matching insieme's askForWorksheet: a
/// request read half-written would send the daemon the wrong id, or none. The
/// signal is sent only once the rename succeeds, and only when `daemonPid` is
/// a real process (`> 1` — `kill(0, …)` hits a process group, `kill(1, …)` hits
/// launchd itself). The helper never reads any other file and never execs
/// anything.
@discardableResult
func writeTrayRequest(action: TrayAction, id: String, in directory: String, daemonPid: Int32) -> Bool {
    let target = (directory as NSString).appendingPathComponent("tray-request.json")
    let staging = "\(target).\(getpid()).tmp"
    guard let body = try? JSONSerialization.data(withJSONObject: ["action": action.rawValue, "id": id]) else {
        return false
    }
    let manager = FileManager.default
    try? manager.removeItem(atPath: staging)
    guard manager.createFile(atPath: staging, contents: body, attributes: [.posixPermissions: 0o600]) else {
        return false
    }
    guard rename(staging, target) == 0 else {
        try? manager.removeItem(atPath: staging)
        return false
    }
    if daemonPid > 1 { kill(daemonPid, SIGUSR1) }
    return true
}

// MARK: - the icon

/// Whether the menu bar should show the lit glyph — AC 2.
func iconIsLit(_ state: TrayState) -> Bool {
    !state.pending.isEmpty
}

/// A small page, drawn rather than shipped as an asset, so it lands on pixel
/// boundaries at every backing scale (`NSImage(size:flipped:)` re-runs this
/// handler per scale). Monochrome and `isTemplate = true` at rest, so the
/// system dims and recolours it like its neighbours; full colour and
/// `isTemplate = false` — the only coloured thing in the row — the moment
/// something is pending. No badge, no animation.
enum PieceIcon {
    static let size = NSSize(width: 16, height: 15)
    private static let ink = CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 1)
    private static let lit = CGColor(srgbRed: 0.937, green: 0.694, blue: 0.129, alpha: 1)
    private static let edge = CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.3)

    static func image(pending: Bool) -> NSImage {
        let image = NSImage(size: size, flipped: false) { rect in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            drawPage(in: ctx, rect: rect, colored: pending)
            return true
        }
        image.isTemplate = !pending
        return image
    }

    /// A page with its top-right corner folded down.
    private static func drawPage(in ctx: CGContext, rect: CGRect, colored: Bool) {
        let page = rect.insetBy(dx: 3, dy: 1)
        let fold: CGFloat = 4
        let path = CGMutablePath()
        path.move(to: CGPoint(x: page.minX, y: page.minY))
        path.addLine(to: CGPoint(x: page.maxX - fold, y: page.minY))
        path.addLine(to: CGPoint(x: page.maxX, y: page.minY + fold))
        path.addLine(to: CGPoint(x: page.maxX, y: page.maxY))
        path.addLine(to: CGPoint(x: page.minX, y: page.maxY))
        path.closeSubpath()

        ctx.saveGState()
        ctx.addPath(path)
        ctx.setFillColor(colored ? lit : ink)
        ctx.fillPath()
        ctx.restoreGState()

        ctx.saveGState()
        ctx.addPath(path)
        ctx.setStrokeColor(colored ? edge : ink)
        ctx.setLineWidth(1)
        ctx.strokePath()
        ctx.restoreGState()
    }
}

// MARK: - the status item

/// Carries a click's `(action, id)` through `NSMenuItem.representedObject`,
/// which must be an object.
final class ActionPayload: NSObject {
    let action: TrayAction
    let id: String
    init(action: TrayAction, id: String) {
        self.action = action
        self.id = id
    }
}

final class TrayController: NSObject {
    private let statePath: String
    private let stateDirectory: String
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private var state = TrayState()
    /// What the menu bar was last drawn from — rebuilding when nothing changed
    /// would replace `statusItem.menu` under a menu the user has open, closing
    /// it (AC 5: "only rebuilds ... when a rendered signature ... changes").
    private var renderedSignature: String?
    private var directorySource: DispatchSourceFileSystemObject?
    private var directoryDescriptor: CInt = -1
    private var fallbackTimer: Timer?
    private var parentTimer: Timer?
    /// Captured before anything else can change it. See `watchParent`.
    private let originalParent = getppid()

    init(statePath: String) {
        self.statePath = statePath
        self.stateDirectory = (statePath as NSString).deletingLastPathComponent
        super.init()
        statusItem.button?.toolTip = "pablo"
        reload()
        watchStateDirectory()
        startFallbackPoll()
        watchParent()
    }

    // MARK: rendering

    private func reload() {
        let next = TrayState.read(statePath)
        let pendingSignature = next.pending
            .map { "\($0.id)|\($0.kind)|\($0.title)|\($0.words)|\($0.at)" }
            .joined(separator: ",")
        let signature = [String(next.daemonPid), next.version, next.lastError, pendingSignature]
            .joined(separator: "||")
        guard signature != renderedSignature else { return }
        renderedSignature = signature
        state = next
        statusItem.button?.image = PieceIcon.image(pending: iconIsLit(state))
        statusItem.menu = buildMenu()
    }

    /// Render `menuEntries` — where every decision about the dropdown lives —
    /// into AppKit. Nothing is decided here. No Quit item: `pablo tray
    /// uninstall` is the off switch, as with insieme, because launchd owns the
    /// lifecycle.
    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        for entry in menuEntries(for: state) { menu.addItem(renderItem(entry)) }
        return menu
    }

    private func renderItem(_ entry: MenuEntry) -> NSMenuItem {
        switch entry {
        case .separator:
            return NSMenuItem.separator()
        case .label(let title):
            return disabled(title)
        case .action(let title, let action, let id):
            let item = NSMenuItem(title: title, action: #selector(handleAction(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = ActionPayload(action: action, id: id)
            return item
        case .submenu(let title, let children):
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let submenu = NSMenu()
            for child in children { submenu.addItem(renderItem(child)) }
            item.submenu = submenu
            return item
        }
    }

    private func disabled(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    @objc private func handleAction(_ sender: NSMenuItem) {
        guard let payload = sender.representedObject as? ActionPayload else { return }
        writeTrayRequest(action: payload.action, id: payload.id, in: stateDirectory, daemonPid: state.daemonPid)
    }

    // MARK: noticing the daemon wrote

    /// Watch the DIRECTORY, not the file — the daemon writes temp-then-rename,
    /// so the inode this helper would have opened is replaced on every write
    /// and a vnode source on the file itself goes deaf after the first one.
    private func watchStateDirectory() {
        directoryDescriptor = open(stateDirectory, O_EVTONLY)
        guard directoryDescriptor >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: directoryDescriptor,
            eventMask: [.write, .delete, .rename],
            queue: .main
        )
        source.setEventHandler { [weak self] in self?.reload() }
        source.setCancelHandler { [weak self] in
            guard let self, self.directoryDescriptor >= 0 else { return }
            close(self.directoryDescriptor)
            self.directoryDescriptor = -1
        }
        source.resume()
        directorySource = source
    }

    /// The belt to the DispatchSource's braces — a vnode source can be lost
    /// (the directory replaced wholesale, a descriptor revoked across a
    /// sleep), so this turns "the flag froze" into "at most ten seconds stale".
    private func startFallbackPoll() {
        fallbackTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            self?.reload()
        }
    }

    // MARK: outliving nobody

    /// AC 5: exit within 2s when the parent changes. `getppid()` answers 1
    /// (launchd) once the parent is reaped, so a changed value means "the
    /// process that started me is gone". Polling rather than watching a pipe:
    /// the daemon spawns this with no stdio to watch, and this must also exit
    /// if the daemon is SIGKILLed, which no graceful message would announce.
    private func watchParent() {
        parentTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            guard let self else { return }
            if getppid() != self.originalParent {
                NSApplication.shared.terminate(nil)
            }
        }
    }
}

// MARK: - entry point

@main
struct PabloTray {
    static func main() {
        let arguments = CommandLine.arguments
        let first = arguments.count > 1 ? arguments[1] : ""

        // `--check` proves the compiled helper can exec without putting an
        // icon in anybody's menu bar — AC 6.
        if first == "--check" {
            FileHandle.standardOutput.write(Data("pablo-tray ok\n".utf8))
            return
        }

        // `--menu <state file>` prints the dropdown this state would produce
        // and exits — AC 6, provable without a status item existing. The menu
        // is a value (`menuEntries`) precisely so this mode needs no
        // NSApplication, no NSStatusBar and nobody's menu bar.
        if first == "--menu" {
            let path = arguments.count > 2 ? arguments[2] : ""
            let rendered = renderMenu(menuEntries(for: TrayState.read(path)))
            FileHandle.standardOutput.write(Data(rendered.utf8))
            return
        }

        // Otherwise argv[1] is the state file, the helper's one argument (AC 1).
        guard !first.isEmpty else {
            FileHandle.standardError.write(Data("pablo-tray: no state file given\n".utf8))
            exit(2)
        }

        let app = NSApplication.shared
        // Belt and braces with LSUIElement in the bundle's Info.plist: no Dock
        // tile, no menu bar of its own, no app switcher entry.
        app.setActivationPolicy(.accessory)
        let controller = TrayController(statePath: first)
        withExtendedLifetime(controller) {
            app.run()
        }
    }
}
