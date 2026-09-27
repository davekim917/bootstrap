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
x="$(echo hi # inside a quoted command substitution
echo bye)"
echo after # the substitution closed
y=`echo hi # inside backquotes
echo bye`
z=${fallback:-$(echo hi # inside a parameter expansion
echo bye)}
