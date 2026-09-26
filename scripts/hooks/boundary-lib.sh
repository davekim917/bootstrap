# Shared by the commit and push hooks (sourced, not run): resolve and run the
# public-boundary checker. This repository is public; the checker compares what
# is about to be published with identifiers from the operator's local install.
#
# Configured per machine with UNTRACKED git config pointing at a checkout that
# carries the checker, its node_modules, its install registry and its identifier
# inventory:
#
#   git config bootstrap.boundaryChecker <path>
#
# Set but unusable (including set to empty) → the hook fails closed. Unset →
# the hook prints one notice and continues: a public contributor has no install
# registry to scan against.

# boundary_checker_dir — prints the configured path; returns 1 when the key is
# absent, 2 when it is present but empty or unreadable.
boundary_checker_dir() {
  _value=$(git config --get bootstrap.boundaryChecker 2>/dev/null) && _status=0 || _status=$?
  case $_status in
    0) if [ -n "$_value" ]; then printf '%s\n' "$_value"; return 0; fi
       echo "boundary: bootstrap.boundaryChecker is set but empty — refusing (fail closed)" >&2
       return 2 ;;
    1) return 1 ;;
    *) echo "boundary: bootstrap.boundaryChecker could not be read — refusing (fail closed)" >&2
       return 2 ;;
  esac
}

# run_boundary_checker <checker-dir> <checker args...>
run_boundary_checker() {
  _checker=$1
  shift
  _script="$_checker/scripts/check-public-boundary.ts"
  _tsx="$_checker/node_modules/.bin/tsx"
  _db="$_checker/data/v2.db"
  _ids="$_checker/.nanoclaw/public-boundary-identifiers"
  for _required in "$_script" "$_tsx" "$_db" "$_ids"; do
    if [ ! -e "$_required" ]; then
      echo "boundary: bootstrap.boundaryChecker is set but $(basename "$_required") is missing there — refusing (fail closed)" >&2
      return 1
    fi
  done
  (cd "$_checker" && "$_tsx" "$_script" --db "$_db" --identifiers "$_ids" "$@") </dev/null
}

# write_committed_allowlist <treeish-prefix> <out-file>
#   treeish-prefix ":" for the index, "<commit>:" for a commit. A tree without
#   the file scans with an empty allowlist.
write_committed_allowlist() {
  if ! git show "$1.public-boundary-allowlist.json" > "$2" 2>/dev/null; then
    printf '{"entries": []}\n' > "$2"
  fi
}
