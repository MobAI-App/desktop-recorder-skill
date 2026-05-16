# desktop-recorder-skill

A macOS-only agent skill that records polished, reproducible screencasts
of desktop or web apps — and a native CLI (`deskagent`) that does the
recording, deterministic input replay, and accessibility / OCR element
discovery.

> **Maintainer:** [MobAI](https://mobai.run) · contact: [contact@mobai.run](mailto:contact@mobai.run) · GitHub: [`@mobai-app`](https://github.com/mobai-app)

> **Platform:** macOS 14+ (Sonoma) on Apple Silicon. macOS only — Linux and
> Windows are out of scope.

The skill teaches an agent to:

1. **Explore** the workflow — `deskagent list`, `deskagent inspect`, screenshots, `deskagent assert`.
2. **Author** a `screenplay.json` — scenes of deterministic actions plus per-scene editing directives (`caption`, `zoom`, `speed`, top-level `trim`).
3. **Normalize state** before recording (window size, theme, navigation to start screen).
4. **Dry-run** the screenplay against the live UI; confirm with `deskagent assert` before the take.
5. **Record** with `deskagent record` (ScreenCaptureKit, per-window) while `deskagent control` drives — `--background` (per-pid + AXPress, no focus shift) for AX-rich apps, HID delivery for Chromium-based web apps.
6. **Edit** via the five-stage pipeline: highlights → zoom → captions → speedups → export. Each stage reads `screenplay + timeline + meta`; sidecars auto-propagate.
7. **Ship** a polished mp4 with click ripples, cursor sprite, captions, variable-speed playback, and optional upload copy.

The golden rule:

```
explore → screenplay → dry-run → record → edit → export
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
screenplay.json       ← single source of truth (scenes + directives)
timeline.json         ← execution evidence (scene_start / action / scene_end)
demo.raw.mp4          ← native recording + .meta.json sidecar
demo.final.mp4        ← final 1920×1080 export (or chosen format)
*.captions.json       ← caption track sidecar
copy.md               ← upload copy
```

Intermediate mp4s flow through the editing pipeline (`demo.hl.mp4` →
`demo.hlz.mp4` → `demo.hlzc.mp4` → `demo.hlzcs.mp4`); see
`skills/desktop-recorder/references/editing.md` for the stage chain.

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
