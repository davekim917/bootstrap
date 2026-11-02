#!/usr/bin/env bash
# Print the Render CLI's version, then every command path it knows, one per line, sorted. Run it in the agent image
# (where the guard's Render commands run) and copy the paths into RENDER_CLI_TREE in block-destructive-core.ts when the
# image's Render CLI moves:
#   docker run --rm -v "$PWD/scripts:/s:ro" --entrypoint bash <agent image> /s/render-cli-tree.sh
set -euo pipefail

walk() {
    local path="$1" sub
    # shellcheck disable=SC2086
    for sub in $(render $path --help 2>/dev/null | awk '/^SUBCOMMANDS/ { on = 1; next } /^FLAGS/ { on = 0 } on && /^  [a-z]/ { print $1 }'); do
        [ "$sub" = help ] && [ -n "$path" ] && continue
        echo "${path:+$path }$sub"
        walk "${path:+$path }$sub"
    done
}

render --version | sed -n 's/^render v//p'
walk "" | LC_ALL=C sort
