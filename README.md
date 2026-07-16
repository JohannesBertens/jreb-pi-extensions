# jreb-pi-extensions

Custom extensions for [pi](https://github.com/earendil-works/pi).

## Extensions

### Custom Footer (`custom-footer.ts`)

Colorful statusline showing token usage, context window progress, git branch, and current model.

**Features:**
- **↑ input / ↓ output** — token counts with colored arrows
- **Context bar** — visual progress bar with color-coded warning levels (green < 70%, yellow 70-90%, red > 90%)
- **● branch** — current git branch
- **model** — active model name

![footer example](./images/footer.png)

## Installation

### Option 0: One-liner (install or update from GitHub)

```bash
curl -fsSL https://raw.githubusercontent.com/JohannesBertens/jreb-pi-extensions/main/install.sh | sh
```

Overwrites the extension files in `~/.pi/agent/extensions/`, so re-running it updates to the latest version. Set `PI_EXTENSIONS_DIR` to target a different folder.

### Option 1: Copy to pi extensions folder

```bash
mkdir -p ~/.pi/agent/extensions
cp custom-footer.ts ~/.pi/agent/extensions/
```

In pi, run:
1. `/reload` — pick up the new extension
2. `/footer` — enable the custom footer (toggle off/on with same command)

### Option 2: Symlink from this repo

```bash
mkdir -p ~/.pi/agent/extensions
ln -sf ~/Projects/jreb-pi-extensions/custom-footer.ts ~/.pi/agent/extensions/
```

Changes to the file are picked up automatically with `/reload`.

### Configure context window

If your model's context window isn't detected, add it to `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "your-provider": {
      "models": [
        { "id": "your-model", "contextWindow": 262144 }
      ]
    }
  }
}
```

## License

MIT
