#!/usr/bin/env bash
#
# Builds the distributable Mindustry mod archive: ./<mod-name>.zip
# Contents: mod.hjson, scripts/, README.md, LICENSE.
#
# Usage: ./build.sh
#
set -euo pipefail
cd "$(dirname "$0")"

name="$(sed -n 's/^name:[[:space:]]*"\([^"]*\)".*/\1/p' mod.hjson | head -n1)"
if [ -z "$name" ]; then
    echo "build.sh: could not read 'name' from mod.hjson" >&2
    exit 1
fi

out="$name.zip"
rm -f "$out"
zip -q -X -r "$out" mod.hjson scripts README.md LICENSE -x '*.DS_Store' -x '*__MACOSX*'

echo "built $out"
unzip -l "$out"
