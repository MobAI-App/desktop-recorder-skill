# desktop-recorder-skill

A macOS-only agent skill that records polished, reproducible screencasts
of desktop or web apps — and a native CLI (`deskagent`) that does the
recording, deterministic input replay, and accessibility / OCR element
discovery.

> **Maintainer:** [MobAI](https://mobai.run) · contact: [contact@mobai.run](mailto:contact@mobai.run) · GitHub: [`@mobai-app`](https://github.com/mobai-app)

> **Platform:** macOS 14+ (Sonoma) on Apple Silicon. macOS only — Linux and
> Windows are out of scope.

The skill teaches an agent to:

1. **Explore** the workflow — `deskagent list`, `deskagent inspect`, screenshots.
2. **Generate** a deterministic JSON script using window-relative coords.
3. **Normalize state** before recording (window size, theme, navigation to start screen).
4. **Dry-run** the script with assertions enabled.
5. **Record** the take with `deskagent record` (ScreenCaptureKit, per-window) running concurrently with `deskagent control --background` (AXPress + per-PID delivery — no focus shift, user keeps working).
6. **Build timeline metadata** for every action.
7. **Export** a polished video with click ripples, captions, and upload copy.

The golden rule:

```
explore → script → dry-run → record → edit/export
```

Never:

```
start recording → observe → think → click → observe → think → click
```

---

## Install

Paste this into Claude Code, Codex, Cursor, or any agent capable of
reading a public repo and running shell commands:

> Set up `https://github.com/mobai-app/desktop-recorder-skill` for me.
>
> Read `install.md` and follow the steps to install `deskagent` and
> register the skill with my agent runtime.

The install flow takes ~2 minutes and:

- Installs `deskagent` via the Homebrew tap (`mobai-app/tap/deskagent`).
- Walks you through Screen Recording + Accessibility permission grants.
- Copies the `skills/desktop-recorder/` folder into your agent's skills directory.
- Verifies end-to-end with `deskagent doctor`.

If you'd rather do it by hand, [`install.md`](./install.md) has the
manual recipe too.

---

## Repo structure

```
desktop-recorder-skill/
├── install.md          # agent-readable installation guide (the entry point)
├── README.md           # this file
├── LICENSE             # MIT
├── CONTRIBUTING.md     # dev setup
├── RELEASING.md        # how new deskagent versions are cut
├── skills/
│   └── desktop-recorder/   # this is what gets copied to your agent
│       ├── SKILL.md
│       ├── references/
│       ├── scripts/
│       └── assets/
├── deskagent/          # native macOS CLI source (Swift, ScreenCaptureKit + AVFoundation + Vision)
│   ├── Sources/
│   ├── scripts/build.sh, install.sh
│   └── README.md
└── .github/workflows/  # release CI: builds deskagent, attaches to GitHub Release on tag
```

---

## How to use it (after install)

Ask your agent things like:

- "Record a screencast of the dashboard flow."
- "Make a launch video for this Mac app."
- "Record me clicking through the onboarding wizard."
- "Cut a 30-second product demo of this macOS app."

The skill triggers automatically. The agent walks the explore → script →
dry-run → record → export pipeline and produces a demo folder containing:

```
demo.script.json      ← reproducible script
timeline.json         ← per-event metadata
demo.raw.mp4          ← native recording, untouched
demo.highlights.mp4   ← with click ripples
demo.horizontal.mp4   ← final 1920×1080 export
*.captions.json       ← caption track (sidecar)
copy.md               ← upload copy
```

---

## Authorization

Driving a user's running apps with `deskagent control` can mutate app
state (open documents, focus, tab order). `--background` mode minimizes
visible disturbance (no cursor movement, no focus shift) but still
mutates the target app. The skill instructs the agent to **ask before
touching anything other than the app the user named for the demo**.

---

## Not in scope (yet)

- Mobile (iOS / Android) demos — use the sibling `mobile-recorder-skill`.
- Linux / Windows — `deskagent` is macOS-only.
- Direct upload to YouTube / TikTok / X.
- AI voiceover or background music.
- A full GUI video editor.

## License

[MIT](./LICENSE) — Copyright © 2026 [MobAI](https://mobai.run).

## Contributing

Bug reports, fixes, and ideas welcome. See [`CONTRIBUTING.md`](./CONTRIBUTING.md)
for development setup and PR conventions. Reach out at
[contact@mobai.run](mailto:contact@mobai.run) for anything that doesn't fit
on the issue tracker.
