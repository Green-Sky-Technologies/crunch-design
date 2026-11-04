#!/usr/bin/env bash
# Create git worktrees for the plan in docs/worktree-plan.md.
#
#   scripts/setup-worktrees.sh foundation    # Phase 0
#   scripts/setup-worktrees.sh phase1        # after feat/foundation is merged into main
#   scripts/setup-worktrees.sh integration   # after every Phase 1 branch is merged
#   scripts/setup-worktrees.sh list | remove <name>
#
# Each worktree gets its own Postgres databases (crunch_<name>, crunch_test_<name>) on the
# shared docker-compose server and its own dev port, so parallel sessions don't collide.
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
REPO_NAME=$(basename "$REPO_ROOT")
PARENT=$(dirname "$REPO_ROOT")
BASE_BRANCH=${BASE_BRANCH:-main}
ENV_SRC="$REPO_ROOT/apps/web/.env.local"

# name:branch:port
FOUNDATION=("foundation:feat/foundation:3010")
PHASE1=(
  "stream-canvas:feat/canvas:3011"
  "stream-agent:feat/agent:3012"
  "stream-design-system:feat/design-system:3013"
  "stream-collab-export:feat/collab-export:3014"
  "stream-figma:feat/figma:3015"
)
INTEGRATION=("integration:feat/integration:3016")

die() { echo "error: $*" >&2; exit 1; }

require_base() {
  git -C "$REPO_ROOT" rev-parse --verify --quiet "$BASE_BRANCH^{commit}" >/dev/null \
    || die "'$BASE_BRANCH' has no commits yet. Commit Epic 1 first (git worktrees need a base commit)."
  [ -f "$ENV_SRC" ] || die "missing $ENV_SRC (copy apps/web/.env.example and fill it in first)"
  (cd "$REPO_ROOT" && docker compose up -d db >/dev/null) || die "could not start Postgres (docker compose)"
  for _ in $(seq 1 30); do
    (cd "$REPO_ROOT" && docker compose exec -T db pg_isready -U crunch >/dev/null 2>&1) && return 0
    sleep 1
  done
  die "Postgres did not become ready"
}

create_db() {
  local db=$1
  (cd "$REPO_ROOT" && docker compose exec -T db psql -U crunch -tAc \
    "select 1 from pg_database where datname='$db'" | grep -q 1) \
    || (cd "$REPO_ROOT" && docker compose exec -T db createdb -U crunch "$db")
}

setup_one() {
  local name=$1 branch=$2 port=$3
  local dir="$PARENT/${REPO_NAME}-wt-${name}"
  local dbname="crunch_${name//-/_}"

  if [ -d "$dir" ]; then
    echo "• $name: already exists at $dir (skipping)"
    return
  fi
  echo "• $name → $dir ($branch, port $port)"
  if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$REPO_ROOT" worktree add "$dir" "$branch"
  else
    git -C "$REPO_ROOT" worktree add "$dir" -b "$branch" "$BASE_BRANCH"
  fi

  # Per-worktree env: same secrets, isolated databases and port.
  sed -E \
    -e "s#^DATABASE_URL=.*#DATABASE_URL=postgres://crunch:crunch@localhost:5433/${dbname}#" \
    "$ENV_SRC" > "$dir/apps/web/.env.local"
  echo "TEST_DATABASE_URL=postgres://crunch:crunch@localhost:5433/crunch_test_${name//-/_}" \
    >> "$dir/apps/web/.env.local"
  # Root .env, sourced before launching the session: tests, migrations and `next dev` (PORT is
  # only read from the process environment, not from .env files) use the isolated settings.
  {
    echo "DATABASE_URL=postgres://crunch:crunch@localhost:5433/${dbname}"
    echo "TEST_DATABASE_URL=postgres://crunch:crunch@localhost:5433/crunch_test_${name//-/_}"
    echo "PORT=$port"
  } > "$dir/.env"

  create_db "$dbname"
  (cd "$dir" && pnpm install --frozen-lockfile >/dev/null && \
    DATABASE_URL="postgres://crunch:crunch@localhost:5433/${dbname}" pnpm db:migrate >/dev/null)
  echo "  ready: cd $dir && set -a && source .env && set +a && claude"
}

run_set() {
  require_base
  local entry
  for entry in "$@"; do
    IFS=: read -r name branch port <<<"$entry"
    setup_one "$name" "$branch" "$port"
  done
  echo
  echo "Prompts for each session: docs/worktree-plan.md → \"Claude Code Prompts\" (shared preamble + stream block)."
}

case "${1:-}" in
  foundation) run_set "${FOUNDATION[@]}" ;;
  phase1)
    git -C "$REPO_ROOT" merge-base --is-ancestor feat/foundation "$BASE_BRANCH" 2>/dev/null \
      || die "feat/foundation is not merged into $BASE_BRANCH yet"
    run_set "${PHASE1[@]}" ;;
  integration) run_set "${INTEGRATION[@]}" ;;
  list) git -C "$REPO_ROOT" worktree list ;;
  remove)
    [ -n "${2:-}" ] || die "usage: $0 remove <name>"
    git -C "$REPO_ROOT" worktree remove "$PARENT/${REPO_NAME}-wt-$2"
    echo "removed worktree $2 (branch kept; its databases are left in Postgres)" ;;
  *) sed -n '2,10p' "$0"; exit 1 ;;
esac
