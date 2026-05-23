# desktop-recorder-skill

A macOS-only agent skill that records polished, reproducible screencasts of
desktop or web apps, plus a native CLI (`deskagent`) for the recording,
deterministic input replay, and accessibility / OCR element discovery.

> **Maintainer:** [MobAI](https://mobai.run) · [contact@mobai.run](mailto:contact@mobai.run) · [`@mobai-app`](https://github.com/mobai-app)
>
> **Platform:** macOS 14+ (Sonoma) on Apple Silicon.

The skill teaches an agent to:

1. **Explore** with `deskagent list / inspect / screenshot / assert`.
2. **Author** a `screenplay.json` - scenes of deterministic actions with
   per-scene `caption` and top-level `zoom` / `speed` / `trim` directives.
3. **Normalize state** (window size, theme, start screen).
4. **Dry-run** against the live UI; confirm with `deskagent assert`.
5. **Record** with `deskagent record` while `deskagent control` drives
   (`--background` for AX-rich apps, HID for Chromium web apps).
6. **Edit** through `highlights -> zoom -> captions -> speedups -> export`.
7. **Ship** an mp4 with click ripples, cursor sprite, captions, variable
   speed, and optional upload copy.

Golden rule: `explore -> screenplay -> dry-run -> record -> edit -> export`.
Never observe-then-decide mid-recording.

## Install

Paste this into Claude Code, Codex, Cursor, or any agent that can read a
public repo and run shell commands:

> Set up `https://github.com/mobai-app/desktop-recorder-skill` for me.
> Read `install.md` and follow the steps to install `deskagent` and
> register the skill with my agent runtime.

The flow installs `deskagent` via Homebrew (`mobai-app/tap/deskagent`),
walks through Screen Recording + Accessibility grants, copies
`skills/desktop-recorder/` into your agent's skills directory, and runs
`deskagent doctor` to verify. Manual recipe in
[`install.md`](./install.md).

## Use

Ask your agent for a recording:

- "Record a screencast of the dashboard flow."
- "Make a launch video for this Mac app."
- "Cut a 30-second product demo of this macOS app."

The skill triggers automatically and produces:

```
screenplay.json       single source of truth (scenes + directives)
timeline.json         execution evidence (scene_start / action / scene_end)
demo.raw.mp4          native recording + .meta.json sidecar
demo.final.mp4        final export (1920x1080 by default)
*.captions.json       caption track sidecar
copy.md               upload copy
```

See `skills/desktop-recorder/references/editing.md` for the editing stage
chain and intermediate mp4s.

## Authorization

`deskagent control` mutates app state (focus, tabs, open docs).
`--background` minimizes the visible impact but still mutates the target.
The skill asks before touching any app the user didn't name.

## Out of scope

Mobile demos (use the sibling `mobile-recorder-skill`), Linux/Windows,
direct upload to YouTube/TikTok/X, AI voiceover/music, GUI video editing.

## License

[MIT](./LICENSE) - Copyright (c) 2026 [MobAI](https://mobai.run).

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for dev setup and PR conventions.
Reach out at [contact@mobai.run](mailto:contact@mobai.run) for anything
that doesn't fit the issue tracker.
