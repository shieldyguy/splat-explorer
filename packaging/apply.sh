#!/bin/bash
# apply.sh - Inject packaging meta tags into index.html
#
# Reads meta.html and injects it between sentinel comments in index.html.
# First run: replaces <title>...</title> with sentinel block.
# Subsequent runs: replaces existing sentinel block with fresh content.
#
# Run from site repo root: ./packaging/apply.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INDEX="$SITE_ROOT/index.html"
META="$SCRIPT_DIR/meta.html"

if [ ! -f "$INDEX" ]; then
    echo "Error: index.html not found at $INDEX"
    exit 1
fi

if [ ! -f "$META" ]; then
    echo "Error: meta.html not found at $META"
    exit 1
fi

BEGIN_SENTINEL="<!-- BEGIN LUNCH PACKAGING -->"
END_SENTINEL="<!-- END LUNCH PACKAGING -->"

if grep -q "$BEGIN_SENTINEL" "$INDEX"; then
    # Subsequent run: replace existing sentinel block
    echo "Updating existing packaging block..."
    awk '
        /<!-- BEGIN LUNCH PACKAGING -->/ {
            print "<!-- BEGIN LUNCH PACKAGING -->"
            while ((getline line < meta) > 0) print line
            close(meta)
            print "<!-- END LUNCH PACKAGING -->"
            skip = 1
            next
        }
        /<!-- END LUNCH PACKAGING -->/ { skip = 0; next }
        !skip { print }
    ' meta="$META" "$INDEX" > "$INDEX.tmp"
else
    # First run: replace <title>...</title> with sentinel block
    echo "First run: injecting packaging block..."
    awk '
        /<title>.*<\/title>/ {
            print "<!-- BEGIN LUNCH PACKAGING -->"
            while ((getline line < meta) > 0) print line
            close(meta)
            print "<!-- END LUNCH PACKAGING -->"
            next
        }
        { print }
    ' meta="$META" "$INDEX" > "$INDEX.tmp"
fi

mv "$INDEX.tmp" "$INDEX"
echo "Packaging applied to index.html"
