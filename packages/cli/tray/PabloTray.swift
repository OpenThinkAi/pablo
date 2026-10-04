// The pablo reader's menu-bar helper (AGT-1589).
//
// A reader should not have to remember to check for a round. This puts one small
// signal on the Mac: a glyph that sits quiet while nothing is waiting and lights
// up the moment a round is. The menu lists the rounds waiting for the reader and
// the rounds already "sent to Matt"; choosing one opens it.
//
// It is a *reader*, on the same design as insieme's tray/InsiemeTray.swift. No
// credential, no network request, no chapter text ever read. Everything it shows
// comes out of one JSON file the daemon rewrites (`tray-state.json`): a round's
// ref, title and sender. A click can ask for exactly one thing, to open a round:
// a small file dropped beside the state file, then a signal (the same
// parcel-then-SIGUSR1 shape as insieme's askForWorksheet). The helper decides
// nothing and execs nothing; the daemon validates the ref and runs `pablo read`.
//
// The daemon spawns this as a child and never has to clean it up: `getppid()`
// is polled, and the moment it changes (the parent exited) the helper
// terminates. Compiled by plain `swiftc`, one file, no Xcode project.

import AppKit
import Foundation

// MARK: - the state file

/// One round: who sent it, its title, and whether the reader has submitted.
struct TrayRound {
    let ref: String
    let title: String
    let sender: String
    let sent: Bool
}

struct TrayState {
    var daemonPid: Int32 = 0
    var version: String = ""
    var rounds: [TrayRound] = []
    var lastError: String = ""
    /// Set by the daemon after a self-update, while that version is the running one.
    var updatedTo: String = ""

    /// Parse the daemon's file, or fall back to "nothing waiting".
    ///
    /// A missing or malformed file renders as no rounds: a helper that raised an
    /// alert over a half-written rename would be worse than one that briefly
    /// shows a quiet icon.
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
        if let updatedTo = root["updatedTo"] as? String { state.updatedTo = updatedTo }
        if let raw = root["rounds"] as? [[String: Any]] {
            state.rounds = raw.compactMap { item in
                guard
                    let ref = item["ref"] as? String,
                    let title = item["title"] as? String,
                    let status = item["status"] as? String
                else { return nil }
                let sender = (item["sender"] as? String) ?? ""
                return TrayRound(ref: ref, title: title, sender: sender, sent: status == "sent")
            }
        }
        return state
    }
}

// MARK: - the dropdown, as a value

/// What a click does: open a round's view.
enum TrayAction: String {
    case open
}

/// One row of the dropdown, as a plain value with no AppKit in it.
///
/// The point, as in insieme: `menuEntries(for:)` can be printed by `--menu` and
/// asserted without a status item existing anywhere, and `buildMenu()` becomes a
/// rendering step with no decisions left in it.
indirect enum MenuEntry: Equatable {
    /// Shown, never clickable.
    case label(String)
    /// Shown and clickable: title, what it asks for, and which round.
    case action(String, TrayAction, String)
    case separator
}

/// The dropdown: "Waiting for you" with one row per open round, then "Sent to
/// Matt" with one row per submitted round (both newest first, as the daemon
/// ordered them, at most eight each), a disabled line when there is nothing, an
/// optional error line, a separator, the version and, after a self-update, "Updated to <v>".
func menuEntries(for state: TrayState) -> [MenuEntry] {
    var entries: [MenuEntry] = []
    let waiting = state.rounds.filter { !$0.sent }
    let sent = state.rounds.filter { $0.sent }

    if waiting.isEmpty && sent.isEmpty {
        entries.append(.label("No rounds"))
    }
    if !waiting.isEmpty {
        entries.append(.label("Waiting for you"))
        for round in waiting.prefix(8) {
            entries.append(.action(roundTitle(round), .open, round.ref))
        }
    }
    if !sent.isEmpty {
        if !waiting.isEmpty { entries.append(.separator) }
        entries.append(.label("Sent to Matt"))
        for round in sent.prefix(8) {
            entries.append(.action(roundTitle(round), .open, round.ref))
        }
    }

    if !state.lastError.isEmpty {
        entries.append(.label(state.lastError))
    }

    entries.append(.separator)
    entries.append(.label(versionLine(for: state)))
    if !state.updatedTo.isEmpty {
        entries.append(.label("Updated to \(state.updatedTo)"))
    }
    return entries
}

func roundTitle(_ round: TrayRound) -> String {
    round.sender.isEmpty ? round.title : "\(round.title) · from \(round.sender)"
}

func versionLine(for state: TrayState) -> String {
    state.version.isEmpty ? "pablo" : "pablo \(state.version)"
}

/// What `--menu` prints: one line per entry. This is the test contract; keep it
/// stable and boring.
func renderMenu(_ entries: [MenuEntry]) -> String {
    var lines: [String] = []
    for entry in entries {
        switch entry {
        case .label(let title):
            lines.append("label: \(title)")
        case .action(let title, let action, let ref):
            lines.append("action: \(title) [\(action.rawValue) \(ref)]")
        case .separator:
            lines.append("separator")
        }
    }
    return lines.joined(separator: "\n") + "\n"
}

// MARK: - the click: parcel, then bell

/// Open a round.
///
/// Written temp-then-rename at 0600, matching insieme's askForWorksheet: a
/// request read half-written would send the daemon the wrong ref, or none. The
/// signal is sent only once the rename succeeds, and only when `daemonPid` is
/// a real process (`> 1` — `kill(0, …)` hits a process group, `kill(1, …)` hits
/// launchd itself). The helper never reads any other file and never execs
/// anything.
@discardableResult
func writeTrayRequest(action: TrayAction, ref: String, in directory: String, daemonPid: Int32) -> Bool {
    let target = (directory as NSString).appendingPathComponent("tray-request.json")
    let staging = "\(target).\(getpid()).tmp"
    guard let body = try? JSONSerialization.data(withJSONObject: ["action": action.rawValue, "ref": ref]) else {
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

/// Whether the menu bar should show the lit glyph: a round is waiting for the reader.
func iconIsLit(_ state: TrayState) -> Bool {
    state.rounds.contains { !$0.sent }
}

/// A small page, drawn rather than shipped as an asset, so it lands on pixel
/// boundaries at every backing scale (`NSImage(size:flipped:)` re-runs this
/// handler per scale). Monochrome and `isTemplate = true` at rest, so the
/// system dims and recolours it like its neighbours; full colour and
/// `isTemplate = false` — the only coloured thing in the row — the moment
/// a round is waiting. No badge, no animation.
enum PageIcon {
    static let size = NSSize(width: 16, height: 15)
    private static let ink = CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 1)
    private static let lit = CGColor(srgbRed: 0.937, green: 0.694, blue: 0.129, alpha: 1)
    private static let edge = CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.3)

    static func image(lit: Bool) -> NSImage {
        let image = NSImage(size: size, flipped: false) { rect in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            drawPage(in: ctx, rect: rect, colored: lit)
            return true
        }
        image.isTemplate = !lit
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

/// Carries a click's `(action, ref)` through `NSMenuItem.representedObject`,
/// which must be an object.
final class ActionPayload: NSObject {
    let action: TrayAction
    let ref: String
    init(action: TrayAction, ref: String) {
        self.action = action
        self.ref = ref
    }
}

final class TrayController: NSObject {
    private let statePath: String
    private let stateDirectory: String
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private var state = TrayState()
    /// What the menu bar was last drawn from — rebuilding when nothing changed
    /// would replace `statusItem.menu` under a menu the user has open, closing
    /// it.
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
        let roundsSignature = next.rounds
            .map { "\($0.ref)|\($0.title)|\($0.sender)|\($0.sent)" }
            .joined(separator: ",")
        let signature = [String(next.daemonPid), next.version, next.lastError, next.updatedTo, roundsSignature]
            .joined(separator: "||")
        guard signature != renderedSignature else { return }
        renderedSignature = signature
        state = next
        statusItem.button?.image = PageIcon.image(lit: iconIsLit(state))
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
        case .action(let title, let action, let ref):
            let item = NSMenuItem(title: title, action: #selector(handleAction(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = ActionPayload(action: action, ref: ref)
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
        writeTrayRequest(action: payload.action, ref: payload.ref, in: stateDirectory, daemonPid: state.daemonPid)
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

    /// Exit within 2s when the parent changes. `getppid()` answers 1
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
        // icon in anybody's menu bar.
        if first == "--check" {
            FileHandle.standardOutput.write(Data("pablo-tray ok\n".utf8))
            return
        }

        // `--menu <state file>` prints the dropdown this state would produce
        // and exits, provable without a status item existing. The menu
        // is a value (`menuEntries`) precisely so this mode needs no
        // NSApplication, no NSStatusBar and nobody's menu bar.
        if first == "--menu" {
            let path = arguments.count > 2 ? arguments[2] : ""
            let rendered = renderMenu(menuEntries(for: TrayState.read(path)))
            FileHandle.standardOutput.write(Data(rendered.utf8))
            return
        }

        // Otherwise argv[1] is the state file, the helper's one argument.
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
