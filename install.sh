#!/usr/bin/env bash
# orcaDeck installer — clones the repo to ~/.orcadeck (or $ORCADECK_HOME) and
# links `orcadeck` onto your PATH. Safe to re-run: it just pulls latest.
#
#   curl -fsSL https://raw.githubusercontent.com/moraisjose/orcaDeck/main/install.sh | sh
set -euo pipefail

REPO_URL="https://github.com/moraisjose/orcaDeck.git"
HOME_DIR="${ORCADECK_HOME:-$HOME/.orcadeck}"
BIN_DIR="${ORCADECK_BIN_DIR:-$HOME/.local/bin}"

if ! command -v git >/dev/null 2>&1; then
  echo "orcaDeck: git is required to install." >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "orcaDeck: python3 (3.9+) is required to run it." >&2
  exit 1
fi

if [ -d "$HOME_DIR/.git" ]; then
  echo "Updating existing install at $HOME_DIR..."
  git -C "$HOME_DIR" pull --ff-only
else
  echo "Cloning orcaDeck into $HOME_DIR..."
  git clone --depth 1 "$REPO_URL" "$HOME_DIR"
fi

chmod +x "$HOME_DIR/bin/orcadeck"
mkdir -p "$BIN_DIR"
ln -sf "$HOME_DIR/bin/orcadeck" "$BIN_DIR/orcadeck"

echo ""
echo "orcaDeck installed. Run:"
echo "  orcadeck serve"
echo ""

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo "$BIN_DIR isn't on your PATH yet — add this to your shell rc file:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac
