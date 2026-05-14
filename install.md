# Installation guide

> This file is meant to be read by an AI agent and executed step-by-step.
> If you're a human reading it, jump to the [Manual recipe](#manual-recipe-no-agent) section at the bottom.

You're installing two things:

1. **`deskagent`** — the native macOS CLI (ScreenCaptureKit recorder + AXPress driver + Vision OCR).
2. **The skill** — `skills/desktop-recorder/` from this repo, copied into the user's agent skills directory.

Total time: ~2 minutes if Homebrew is already installed.

---

## Pre-flight checks

Run these and stop if anything fails — don't try to "fix" missing prerequisites silently.

```bash
sw_vers -productVersion           # expect 14.x or higher (Sonoma+)
uname -m                          # expect arm64 (only for Option A)
```

If `uname -m` reports `x86_64`, skip Option A (the brew bottle is arm64-only) and use Option C.

---

## Step 1 — Install `deskagent`

Pick one of three options. The agent should pick **A** by default and fall back to the others if A fails.

### Option A — Homebrew (recommended for Apple Silicon, macOS 14+)

```bash
brew install mobai-app/tap/deskagent
deskagent --version              # expect 0.1.0 or newer
```

Pros: one command, auto-updates via `brew upgrade`.
Cons: Apple Silicon only (the bottle is arm64); each `brew upgrade` re-prompts macOS for Screen Recording (ad-hoc signed binary, fresh identity per release — see Step 2).

### Option B — Download a pre-built binary from GitHub Releases

```bash
# Pick the latest release version
LATEST=$(curl -fsSL https://api.github.com/repos/mobai-app/desktop-recorder-skill/releases/latest \
         | python3 -c "import json,sys; print(json.load(sys.stdin)['tag_name'])")
URL="https://github.com/mobai-app/desktop-recorder-skill/releases/download/${LATEST}/deskagent-${LATEST}-macos-arm64.tar.gz"

mkdir -p "$HOME/.local/bin"
curl -fsSL "$URL" | tar -xz -C "$HOME/.local/bin"
xattr -d com.apple.quarantine "$HOME/.local/bin/deskagent" 2>/dev/null || true
chmod +x "$HOME/.local/bin/deskagent"
deskagent --version
```

Pros: no Homebrew needed; can pin a specific version with `LATEST=v0.1.0`.
Cons: manual `xattr` step (Gatekeeper marks downloaded binaries as quarantined); Apple Silicon only; no auto-updates.

### Option C — Build from source

```bash
# Requires Xcode 15+ / Swift 5.9+ toolchain
git clone https://github.com/mobai-app/desktop-recorder-skill.git /tmp/drs
cd /tmp/drs/deskagent
./scripts/build.sh && ./scripts/install.sh
deskagent --version
```

Pros: works on Intel Macs (Swift handles the arch); no quarantine; no brew dependency; you can audit/modify the source.
Cons: needs Xcode toolchain installed (~10 GB) and a couple of minutes to compile.

---

## Step 2 — Grant macOS permissions

`deskagent record` needs **Screen Recording**. `deskagent control` additionally needs **Accessibility**. macOS prompts on first use; pre-trigger them:

```bash
deskagent doctor                          # prompts Screen Recording on first call
deskagent doctor --request-accessibility  # prompts Accessibility (no-op if already granted)
```

Then ask the user to open System Settings:

- Privacy & Security → **Screen Recording** → enable `deskagent`
- Privacy & Security → **Accessibility** → enable `deskagent`

After granting, run `deskagent doctor` again. **Both must report green** before continuing.

> macOS quirk: every `brew upgrade` (Option A) or new `download from release` (Option B) creates a fresh anonymous identity, so Screen Recording grant has to be re-confirmed on each version bump. Building from source (Option C) with a stable self-signed cert avoids this.

---

## Step 3 — Register the skill

The skill is the `skills/desktop-recorder/` folder from this repo. Where it goes depends on the agent runtime:

| Runtime | Skills directory |
|---|---|
| Claude Code | `~/.claude/skills/` |
| Codex CLI | `~/.codex/skills/` (if you use a skill manager) |
| Cursor / Continue / generic | Wherever your agent looks; or paste `SKILL.md` content into the system prompt |

**Detect, then install.** Try the most likely path first:

```bash
SKILL_DIR=""
for candidate in "$HOME/.claude/skills" "$HOME/.codex/skills"; do
    if [[ -d "$candidate" ]]; then
        SKILL_DIR="$candidate"
        break
    fi
done

if [[ -z "$SKILL_DIR" ]]; then
    echo "No known skills directory found."
    echo "If you're on Claude Code, create ~/.claude/skills/ and re-run."
    echo "If you're using a different runtime, copy skills/desktop-recorder/SKILL.md into your agent's system prompt manually."
    exit 1
fi

# If you didn't already clone the repo in Option C, clone it now:
TMP="${TMP:-/tmp/drs}"
[[ -d "$TMP/.git" ]] || git clone https://github.com/mobai-app/desktop-recorder-skill.git "$TMP"

# Copy the skill folder into place
DEST="$SKILL_DIR/desktop-recorder"
rm -rf "$DEST"
cp -R "$TMP/skills/desktop-recorder" "$DEST"
echo "Installed skill at: $DEST"
```

The skill folder contains:

```
SKILL.md             ← main agent instructions (auto-loaded by trigger phrases)
references/          ← desktop.md, deskagent.md, timeline.md, editing.md
scripts/             ← export_video.sh, add_highlights.js, generate_copy.js
assets/              ← examples + templates
```

---

## Step 4 — Verify end-to-end

```bash
deskagent doctor                                            # both green
ls "$SKILL_DIR/desktop-recorder/SKILL.md"                   # skill installed

# Quick functional smoke (records 2 seconds of any visible window)
ID=$(deskagent list --json | python3 -c "import json,sys; print(json.load(sys.stdin)['windows'][0]['id'])")
deskagent record /tmp/install-smoke.mp4 --window "$ID" --quiet --json --pid-file /tmp/sm.pid &
PID=$!; sleep 2; kill -INT "$(cat /tmp/sm.pid)"; wait "$PID"
ls -la /tmp/install-smoke.mp4
```

If the smoke recording exists and is non-empty, install is complete. The user can now ask the agent things like:

> "Record a 30-second demo of MyApp."
> "Make a screencast of the dashboard flow in Safari."

The skill will trigger automatically.

---

## Manual recipe (no agent)

```bash
# 1. Install the CLI (pick one of A / B / C above; A shown here)
brew install mobai-app/tap/deskagent

# 2. Open System Settings → Privacy & Security and grant
#    Screen Recording + Accessibility to "deskagent"

# 3. Install the skill folder
git clone https://github.com/mobai-app/desktop-recorder-skill.git /tmp/drs
mkdir -p ~/.claude/skills
cp -R /tmp/drs/skills/desktop-recorder ~/.claude/skills/desktop-recorder

# 4. Verify
deskagent doctor
```

---

## Uninstall

```bash
# Pick the matching uninstall for the install option you used:
brew uninstall deskagent && brew untap mobai-app/tap     # Option A
rm -f ~/.local/bin/deskagent                             # Option B
# Option C: same as B (the install.sh copies to ~/.local/bin)

# Remove the skill
rm -rf ~/.claude/skills/desktop-recorder                 # adjust path for your runtime
```

You may also want to revoke Screen Recording / Accessibility for `deskagent` in System Settings → Privacy & Security.
