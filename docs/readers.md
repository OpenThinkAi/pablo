# Sharing chapters with readers

pablo can send chapters to a reader, let them read and mark them up in a window on
their own Mac, and bring their notes back into your vault as a branch you review
like any other change. The transport is GitHub: each book gets a private reading
repository, each round is a pull request, and a reader's notes are a review on it.

> **Current limitation.** Reading repositories are created in the `OpenThinkAi`
> GitHub organization, and that is not configurable yet. Outside that organization,
> `share` and `read --list` will not work. Everything else in pablo does
> not depend on this.

## For the author

You need the GitHub CLI (`gh`), signed in. Add each reader to your config (see
[configuration.md](configuration.md#readers)):

```json
{ "readers": { "sam": { "github": "sam-reads", "name": "Sam Lee", "email": "sam@example.com" } } }
```

Then:

```sh
pablo share --project lighthouse --reader sam --chapters 1-3
```

The chapters must already be on `main`. The first share creates the book's private
reading repo and invites the reader; each share opens a round. Only `chapters/` files
ever go to that repo. `pablo share --list --project lighthouse` shows each round as
`open`, `submitted` or `pulled`.

When a reader has submitted:

```sh
pablo notes pull --project lighthouse
```

Each suggestion becomes a commit on a `reader/<round>` branch, authored as the reader,
and every comment is attached for the screen's review mode. The round's pull request
is then closed. Review the branch in the screen (bare `pablo`) and take what you want.

## For readers

If you read chapters for an author and are not a developer, this is all you need. Open
the Terminal app, paste this one line, and press Return:

```sh
curl -fsSL https://raw.githubusercontent.com/OpenThinkAi/pablo/main/install-reader.sh | sh
```

It says what it is doing at each step. It installs what your Mac is missing (Bun and
the GitHub CLI), installs pablo, and asks you to sign in to GitHub in your browser. It also checks
for Apple's developer tools (if they are missing it opens Apple's installer; run the
line again when that finishes) and [Google Chrome](https://www.google.com/chrome/),
where chapters open. Running it again is safe: it skips what is installed and
upgrades pablo.

You also need a GitHub account with access to the book's reading repo. The author
invites you; accept the invitation from GitHub's email once per book.

To upgrade pablo, run the install line again. `pablo read --list` shows the rounds waiting for you and
`pablo read <book>-reading#<number>` opens one.

## Removing pablo

To remove pablo, run `bun remove -g @openthink/pablo`.

## Removing an old tray

Earlier versions installed a menu-bar tray (`pablo tray`), which this version
removes. Running the install line again removes it for you. To do it by hand instead, run:

```sh
launchctl bootout gui/$(id -u)/ai.openthink.pablo.tray
rm -f ~/Library/LaunchAgents/ai.openthink.pablo.tray.plist
rm -rf ~/Library/Application\ Support/pablo/PabloTray.app
rm -rf ~/.local/state/pablo/tray
```

The `tray.autoUpdate` config key is gone too; pablo no longer reads it.
