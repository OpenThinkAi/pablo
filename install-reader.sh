#!/bin/sh
# pablo reader installer (AGT-1590).
#
#   curl -fsSL https://raw.githubusercontent.com/OpenThinkAi/pablo/main/install-reader.sh | sh
#
# Sets up a reader's Mac in one go: Xcode Command Line Tools check, Google Chrome check, Bun, the
# GitHub CLI (gh), pablo itself (from npm), a GitHub sign-in, and pablo's menu-bar tray.
#
# Safe to run again: it skips what is already there and upgrades pablo.
# Safe to pipe into sh: everything lives in functions and nothing runs until the very last line,
# so a download cut off half-way does nothing.
#
# Test seams (the tests stub every external command; readers never need these):
#   PABLO_INSTALL_APPS  colon-separated folders searched for "Google Chrome.app"
#   PABLO_INSTALL_TTY   the terminal `gh auth login` reads from (default /dev/tty)

set -eu

CHROME_URL="https://www.google.com/chrome/"
BUN_INSTALL_URL="https://bun.sh/install"
GH_RELEASE_API="https://api.github.com/repos/cli/cli/releases/latest"
GH_RELEASE_BASE="https://github.com/cli/cli/releases/download"
PABLO_PACKAGE="@openthink/pablo"
UILEAF_PACKAGE="@openthink/ui-leaf"

STEP=0
CHROME_MISSING=0

say() { printf '%s\n' "$*"; }
step() {
  STEP=$((STEP + 1))
  printf '\n[%s] %s\n' "$STEP" "$*"
}
ok() { printf '    OK: %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }

# Stop with a plain message. Nothing after this runs.
die() {
  printf '\nStopped: %s\n' "$1" >&2
  shift
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
  printf '\nNothing is broken: fix the above, then run the same command again.\n' >&2
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

# Run a command; if it fails, stop with the message.
must() {
  what=$1
  shift
  if ! "$@"; then
    die "$what did not work." "The command that failed: $*" "If it printed a reason above, that is the thing to fix."
  fi
}

bun_home() { printf '%s' "${BUN_INSTALL:-$HOME/.bun}"; }

add_bun_to_path() {
  case ":$PATH:" in
    *":$(bun_home)/bin:"*) ;;
    *) PATH="$(bun_home)/bin:$PATH" ;;
  esac
  export PATH
}

check_mac() {
  if [ "$(uname -s)" != "Darwin" ]; then
    die "this installer is for Macs." "pablo's reader tools run on macOS only."
  fi
}

check_xcode_clt() {
  step "Checking Apple's developer tools (needed to build the menu-bar icon)"
  if xcode-select -p >/dev/null 2>&1; then
    ok "Apple's developer tools are installed."
    return 0
  fi
  note "They are not installed. Asking macOS to install them now."
  note "A window from Apple is about to open: click Install and wait for it to finish"
  note "(a few minutes). Then run this same command again to carry on."
  xcode-select --install >/dev/null 2>&1 || true
  die "Apple's developer tools are not installed yet." \
    "Finish the Apple installer window that just opened, then run this command again."
}

app_dirs() { printf '%s' "${PABLO_INSTALL_APPS:-/Applications:$HOME/Applications}"; }

check_chrome() {
  step "Checking for Google Chrome (pablo shows chapters in a Chrome window)"
  old_ifs=$IFS
  IFS=:
  for dir in $(app_dirs); do
    if [ -d "$dir/Google Chrome.app" ]; then
      IFS=$old_ifs
      ok "Google Chrome is installed."
      return 0
    fi
  done
  IFS=$old_ifs
  CHROME_MISSING=1
  note "Google Chrome is not installed. pablo needs it to show you the chapters."
  note "This installer does not install Chrome for you. Download it here, drag it"
  note "into Applications, and open it once: $CHROME_URL"
  note "Carrying on with the rest of the setup in the meantime."
}

arch_name() {
  case "$(uname -m)" in
    arm64 | aarch64) printf 'arm64' ;;
    *) printf 'amd64' ;;
  esac
}

install_bun() {
  step "Checking for Bun (the engine pablo runs on)"
  add_bun_to_path
  if have bun; then
    ok "Bun is installed ($(bun --version 2>/dev/null || printf 'version unknown'))."
    return 0
  fi
  if have brew; then
    note "Bun is missing. Installing it with Homebrew."
    must "Installing Bun with Homebrew" brew install oven-sh/bun/bun
  else
    note "Bun is missing. Installing it with Bun's own installer (bun.sh)."
    tmp=$(mktemp)
    must "Downloading Bun's installer" curl -fsSL "$BUN_INSTALL_URL" -o "$tmp"
    if ! bash "$tmp"; then
      rm -f "$tmp"
      die "Bun's installer did not finish." "You can try it by hand: $BUN_INSTALL_URL"
    fi
    rm -f "$tmp"
  fi
  add_bun_to_path
  have bun || die "Bun was installed but this window cannot find it." \
    "Close this Terminal window, open a new one, and run the command again."
  ok "Bun is installed."
}

# gh without Homebrew: GitHub's own macOS download, placed beside bun (a folder pablo's tray also searches).
install_gh_from_release() {
  tag=$(curl -fsSL "$GH_RELEASE_API" | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$tag" ] || die "Could not find the latest GitHub CLI release." \
    "Check your internet connection, or install it from https://cli.github.com and run this again."
  name="gh_${tag}_macOS_$(arch_name)"
  work=$(mktemp -d)
  must "Downloading the GitHub CLI" curl -fsSL "$GH_RELEASE_BASE/v$tag/$name.zip" -o "$work/gh.zip"
  must "Unpacking the GitHub CLI" unzip -q "$work/gh.zip" -d "$work"
  mkdir -p "$(bun_home)/bin"
  must "Placing the GitHub CLI" cp "$work/$name/bin/gh" "$(bun_home)/bin/gh"
  chmod +x "$(bun_home)/bin/gh"
  rm -rf "$work"
}

install_gh() {
  step "Checking for the GitHub CLI, gh (how pablo talks to GitHub for you)"
  if have gh; then
    ok "gh is installed."
    return 0
  fi
  if have brew; then
    note "gh is missing. Installing it with Homebrew."
    must "Installing gh with Homebrew" brew install gh
  else
    note "gh is missing. Downloading GitHub's official build."
    install_gh_from_release
  fi
  add_bun_to_path
  have gh || die "gh was installed but this window cannot find it." \
    "Close this Terminal window, open a new one, and run the command again."
  ok "gh is installed."
}

uileaf_binary_present() {
  base="$(bun_home)/install/global/node_modules"
  for candidate in \
    "$base/$UILEAF_PACKAGE/bin/ui-leaf-bin" \
    "$base/$PABLO_PACKAGE/node_modules/$UILEAF_PACKAGE/bin/ui-leaf-bin"; do
    [ -f "$candidate" ] && return 0
  done
  return 1
}

install_pablo() {
  step "Installing (or upgrading) pablo from npm"
  # --trust: bun skips install scripts by default, and ui-leaf's one downloads the program
  # that opens the chapter window. It is trusted by name below too, because it is a dependency of pablo.
  must "Installing pablo" bun add -g --trust "$PABLO_PACKAGE@latest"
  add_bun_to_path
  have pablo || die "pablo was installed but this window cannot find it." \
    "Close this Terminal window, open a new one, and run the command again."
  note "Allowing the chapter-window component to finish its own setup."
  # Already-trusted on a re-run is fine; whether the binary really arrived is checked next.
  bun pm -g trust "$UILEAF_PACKAGE" >/dev/null 2>&1 || true
  if ! uileaf_binary_present; then
    die "the chapter-window component did not finish downloading." \
      "Try again on a working internet connection. If it keeps failing, run:" \
      "  bun pm -g trust $UILEAF_PACKAGE" \
      "and then this command once more."
  fi
  ok "pablo is installed and ready."
}

gh_signed_in() { gh auth status >/dev/null 2>&1; }

sign_in_github() {
  step "Signing in to GitHub"
  if gh_signed_in; then
    ok "You are already signed in to GitHub."
    return 0
  fi
  tty=${PABLO_INSTALL_TTY:-/dev/tty}
  if ! (: <"$tty") 2>/dev/null; then
    die "GitHub sign-in needs a Terminal window you can type in." \
      "Open the Terminal app and run this command there."
  fi
  note "Follow the prompts: choose GitHub.com, HTTPS, and sign in with your web browser."
  if ! gh auth login <"$tty"; then
    die "the GitHub sign-in did not finish." "Run this command again to retry it."
  fi
  gh_signed_in || die "GitHub still does not show you as signed in." "Run this command again to retry."
  ok "Signed in to GitHub."
}

start_tray() {
  step "Starting pablo's menu-bar tray (it tells you when a chapter is ready to read)"
  must "Starting the tray" pablo tray install
  ok "The tray is installed and will start whenever you log in."
}

finish() {
  printf '\nAll done. pablo is installed.\n'
  if [ "$CHROME_MISSING" -eq 1 ]; then
    printf '\nOne thing left: install Google Chrome so chapters can open: %s\n' "$CHROME_URL"
  fi
  printf '\nTo see the chapters waiting for you, run: pablo read --list\n'
  printf 'To upgrade pablo later, run this same command again.\n'
}

main() {
  say "Setting up pablo for reading. Each step says what it is doing."
  check_mac
  check_xcode_clt
  check_chrome
  install_bun
  install_gh
  install_pablo
  sign_in_github
  start_tray
  finish
}

# Last line on purpose: a half-downloaded script never reaches it.
main "$@"
