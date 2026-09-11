#!/usr/bin/env bash
# Start orcad. Prints a local URL and a LAN URL (with a pairing token) —
# open the LAN one on the iPad once; the browser remembers the token after.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec python3 orcad/orcad.py "$@"
