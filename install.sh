#!/bin/sh
# install.sh — install or update jreb-pi-extensions from GitHub.
#
# One-liner (curl | sh):
#   curl -fsSL https://raw.githubusercontent.com/JohannesBertens/jreb-pi-extensions/main/install.sh | sh
#
# Or with wget:
#   wget -qO- https://raw.githubusercontent.com/JohannesBertens/jreb-pi-extensions/main/install.sh | sh
#
# Options (env vars):
#   PI_EXTENSIONS_DIR  target directory  (default: ~/.pi/agent/extensions)
set -eu

REPO="JohannesBertens/jreb-pi-extensions"
BRANCH="main"
DEST="${PI_EXTENSIONS_DIR:-$HOME/.pi/agent/extensions}"

# --- pick a downloader -------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
    dl() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then
    dl() { wget -qO- "$1"; }
else
    printf 'error: this script needs curl or wget installed.\n' >&2
    exit 1
fi

# --- discover the .ts extension files via the GitHub API ---------------------
# (Auto-discovery: any new .ts file pushed to the repo is picked up.)
list=$(dl "https://api.github.com/repos/$REPO/contents/?ref=$BRANCH" \
        | grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*\.ts"' \
        | sed -E 's/.*"([^"]*\.ts)"/\1/')

if [ -z "$list" ]; then
    printf 'error: could not list extension files from GitHub\n' >&2
    printf '       (rate-limited? try again in a few minutes).\n' >&2
    exit 1
fi

# --- install / update --------------------------------------------------------
mkdir -p "$DEST"
printf 'Installing jreb-pi-extensions into: %s\n' "$DEST"

count=0
for name in $list; do
    dl "https://raw.githubusercontent.com/$REPO/$BRANCH/$name" > "$DEST/$name"
    printf '  + %s\n' "$name"
    count=$((count + 1))
done

printf '\nDone — %d extension(s) installed/updated.\n' "$count"
printf 'In pi: run /reload, then enable the extension (e.g. /footer).\n'
