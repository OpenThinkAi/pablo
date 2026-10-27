# Sharing chapters with readers

pablo can send chapters to a reader, let them review them as a pull request on GitHub, and bring their notes back into your vault as a branch you review
like any other change. The transport is GitHub: each book gets a private reading
repository, each round is a pull request, and a reader's notes are a review on it.

> **Current limitation.** Reading repositories are created in the `OpenThinkAi`
> GitHub organization, and that is not configurable yet. Outside that organization,
> `share` will not work. Everything else in pablo does
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

You do not need to install anything. When the author shares chapters with you, GitHub
emails you an invitation to the book's private reading repository (accept it once per
book). Then open the pull request your author sent you on GitHub and review the
chapters there.

The old reader window (`pablo read`) and its installer's setup are gone. If an earlier
version put pablo's menu-bar tray on your Mac, the cleanup line below removes it; it
installs nothing:

```sh
curl -fsSL https://raw.githubusercontent.com/OpenThinkAi/pablo/main/install-reader.sh | sh
```

## Removing pablo

To remove pablo, run `bun remove -g @openthink/pablo`.

## Removing an old tray

Earlier versions installed a menu-bar tray (`pablo tray`), which this version
removes. Running the cleanup line above removes it for you. To do it by hand instead, run:

```sh
launchctl bootout gui/$(id -u)/ai.openthink.pablo.tray
rm -f ~/Library/LaunchAgents/ai.openthink.pablo.tray.plist
rm -rf ~/Library/Application\ Support/pablo/PabloTray.app
rm -rf ~/.local/state/pablo/tray
```

The `tray.autoUpdate` config key is gone too; pablo no longer reads it.
