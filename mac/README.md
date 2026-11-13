# Nalo Code macOS test build

This folder is the macOS shell. It reuses the existing `server.mjs` and `web/` from the repository root.

## Build on GitHub

1. Upload the repository contents to GitHub.
2. Open **Actions → Build macOS test package → Run workflow**.
3. Wait for the macOS runner.
4. Download the `NaloCode-mac-unsigned` artifact.

The DMG is unsigned, so the first launch needs:

- System Settings → Privacy & Security → Open Anyway

Or:

```bash
xattr -dr com.apple.quarantine "/Applications/Nalo Code.app"
```

## Local build (macOS only)

```bash
bash mac/prepare.sh
cd mac
npm install
npm run dist
```

Output: `mac/dist/*.dmg`

## Notes

- User data is stored in macOS Application Support, not in this repository.
- The first test build does not include Apple signing/notarization.
- Office preview and local model runtime need separate macOS adapters later.
