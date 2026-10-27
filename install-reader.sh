#!/bin/sh
# pablo reader cleanup (AGT-1590, reduced by AGT-2092).
#
#   curl -fsSL https://raw.githubusercontent.com/OpenThinkAi/pablo/main/install-reader.sh | sh
#
# pablo's reader window is gone: a reader now reviews the chapters in the pull request their author
# sent them on GitHub, and needs nothing installed. This script only removes the old reader menu-bar
# tray if an earlier version put it on this Mac, then says where to review. It installs nothing.
#
# Safe to run again. Safe to pipe into sh: everything lives in functions and nothing runs until the
# very last line, so a download cut off half-way does nothing.

set -eu

say() { printf '%s\n' "$*"; }

# Stop with a plain message. Nothing after this runs.
die() {
  printf '\nStopped: %s\n' "$1" >&2
  exit 1
}

check_mac() {
  if [ "$(uname -s)" != "Darwin" ]; then
    die "this cleanup is for Macs."
  fi
}

# Earlier versions installed a menu-bar tray. pablo no longer has a `tray` verb, so a leftover launchd
# agent would fail and restart forever. Remove it when present; do nothing otherwise.
remove_old_tray() {
  plist="$HOME/Library/LaunchAgents/ai.openthink.pablo.tray.plist"
  [ -f "$plist" ] || return 0
  say "Removing the old pablo menu-bar tray (pablo no longer has one)"
  launchctl bootout "gui/$(id -u)/ai.openthink.pablo.tray" >/dev/null 2>&1 || true
  rm -f "$plist"
  rm -rf "$HOME/Library/Application Support/pablo/PabloTray.app" "${XDG_STATE_HOME:-$HOME/.local/state}/pablo/tray"
  rm -f "$HOME/Library/Logs/pablo/tray.log" "$HOME/Library/Logs/pablo/tray.err"
  say "The old tray is removed."
}

finish() {
  printf '\nAll done. Nothing needs installing.\n'
  printf 'Next: open the pull request your author sent you on GitHub and review the chapters there.\n'
}

main() {
  check_mac
  remove_old_tray
  finish
}

# Last line on purpose: a half-downloaded script never reaches it.
main "$@"
