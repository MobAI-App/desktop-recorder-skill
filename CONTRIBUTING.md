# Contributing

Thanks for your interest in `desktop-recorder-skill`. The repo has two
moving parts: the agent skill (Markdown + JSON examples + helper scripts)
and the native macOS CLI (`deskagent`, Swift). PRs to either are welcome.

Maintainer: [MobAI](https://mobai.run) · contact: contact@mobai.run

## Repo layout

| Path | What it is |
|---|---|
| `SKILL.md`, `references/`, `scripts/`, `assets/` | Agent skill — instructions, references, reusable scripts, JSON examples |
| `deskagent/` | Native macOS CLI (Swift package). Capture, deterministic input replay, accessibility + OCR inspection |
| `LICENSE`, `README.md`, `CONTRIBUTING.md` | Repo metadata |

## Development setup

### Skill / scripts

No build step. Edit Markdown / shell / JS in place. The skill loads
whatever's in `SKILL.md`, references in `references/`, scripts in
`scripts/`. Test locally by pointing your agent at the folder.

If you change shell scripts, run them against a real demo to confirm
they exit cleanly and produce the expected files.

### `deskagent` (macOS, Swift 5.9+)

```bash
cd deskagent
swift build                      # debug build at .build/debug/deskagent
swift run deskagent doctor       # check Screen Recording permission

./scripts/build.sh               # release build, signed (Developer ID if available)
./scripts/install.sh             # copies to ~/.local/bin/deskagent
```

The build script auto-picks a stable signing identity (Developer ID >
Apple Development > self-signed `deskagent-codesign` > ad-hoc). Stable
signing matters: macOS TCC tracks Screen Recording permission by signing
identity, so an unstable identity forces re-grants on every rebuild.

To create a self-signed identity for development:
- Keychain Access → Certificate Assistant → Create a Certificate…
- Name: `deskagent-codesign`, Identity Type: Self Signed Root, Certificate Type: Code Signing

### Smoke tests

There's no automated test suite (yet). Manual smoke checks:

```bash
deskagent doctor                                # permission OK?
deskagent list --json | head                    # enumerate windows
deskagent record /tmp/x.mp4 --window <id> &     # record 2s
sleep 2 && kill -INT $!
ffprobe /tmp/x.mp4                              # verify codec / color tags
```

For control flows, write a tiny `script.json` with a single click + type
step against a known target (e.g. TextEdit) and verify the result.

## PR conventions

- Keep changes focused — one fix or one feature per PR.
- Update `references/deskagent.md` when you change CLI surface or add flags.
- Update `SKILL.md` when you change the macOS pipeline or add new agent-facing recipes.
- Don't commit demo recordings (`.mov` / `.mp4`) unless they go under
  `assets/examples/`. The top-level `.gitignore` already covers `demo-out/`.
- Style: follow what's around the change. No automated formatter is
  enforced for Swift; aim for readable + descriptive variable names.

## Filing bugs

Useful info for repro:
- macOS version (`sw_vers`)
- Apple Silicon / Intel
- Output of `deskagent doctor --json`
- The exact `deskagent` command and its full `--json` stderr/stdout
- For visual issues (color, capture region): a `screencapture -l <id>`
  reference vs the produced `.mp4`, plus `ffprobe -show_streams` output

## Code of conduct

Be kind. Anything else, send to contact@mobai.run.
