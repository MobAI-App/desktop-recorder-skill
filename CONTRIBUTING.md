# Contributing

`desktop-recorder-skill` is the agent skill: Markdown instructions, JSON
examples, and helper scripts that drive the screencast pipeline. PRs
welcome.

The native macOS CLI it depends on (`deskagent`) lives in a separate
private repo. Release binaries are attached to this repo's
[Releases](https://github.com/MobAI-App/desktop-recorder-skill/releases)
and shipped via the `mobai-app/homebrew-tap` formula.

Maintainer: [MobAI](https://mobai.run) - contact@mobai.run

## Development setup

No build step. Edit Markdown / JS in place. The skill loads whatever's
in `SKILL.md`, references in `references/`, scripts in `scripts/`. Test
locally by pointing your agent at the folder.

If you change a `scripts/*.js`, run it against a real demo to confirm
it exits cleanly and produces the expected files.

## PR conventions

- Keep changes focused: one fix or one feature per PR.
- Update `references/deskagent.md` if the change relies on a new
  `deskagent` flag.
- Update `SKILL.md` when you change the pipeline or add new
  agent-facing recipes.
- Don't commit demo recordings (`.mov` / `.mp4`) unless they go under
  `skills/desktop-recorder/assets/examples/`.

## Filing bugs

Useful info for repro:
- macOS version (`sw_vers`)
- Apple Silicon / Intel
- `deskagent --version`
- `deskagent doctor --json`
- The exact `deskagent` command and its full `--json` stderr/stdout
- For visual issues: a `screencapture -l <id>` reference vs the
  produced `.mp4`, plus `ffprobe -show_streams` output

## Code of conduct

Be kind. Anything else, send to contact@mobai.run.
