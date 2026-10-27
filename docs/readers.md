# Reading rounds are gone

pablo no longer sends chapters to readers (`pablo share`), pulls their notes
(`pablo notes pull`) or has a `readers` config key; an old `readers` key in your
config is ignored. Sharing a manuscript is now done outside pablo.

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
