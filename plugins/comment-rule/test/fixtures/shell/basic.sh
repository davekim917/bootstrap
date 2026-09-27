#!/usr/bin/env bash
# a comment
echo "# not a comment" '# nor this' a#b $# ${x#y} ${#x}
echo "$(printf "%s" "a #b")"
cat <<EOF
# heredoc body, not a comment
EOF
cat <<-'END'
	# still heredoc
	END
x=$(( 1 # 2 ))
echo done # trailing comment
