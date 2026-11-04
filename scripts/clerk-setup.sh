#!/usr/bin/env bash
# Configure a Clerk instance for CrunchDesign: Organizations (workspaces) with slugs and forced
# selection, plus the org:editor / org:viewer roles (see packages/authz), with org:viewer as the
# default role for new members.
#
#   scripts/clerk-setup.sh            # linked dev instance
#   scripts/clerk-setup.sh prod       # production instance (confirm first!)
#
# Requires `clerk auth login` and a linked project (run from apps/web). Safe to re-run.
set -euo pipefail
INSTANCE=${1:-dev}
clerk() { npx -y clerk@latest "$@" --instance "$INSTANCE"; }
cd "$(dirname "$0")/../apps/web"

echo "• Enabling organizations (forced selection) on $INSTANCE"
clerk enable orgs --force-selection --yes >/dev/null

echo "• Enabling organization slugs (workspace URLs are /w/<slug>)"
tmp=$(mktemp)
echo '{"organization_settings":{"slug_disabled":false}}' > "$tmp"
clerk config patch --file "$tmp" --yes >/dev/null
rm -f "$tmp"

perm_id=$(clerk api "/organization_permissions?limit=100" |
  python3 -c "import sys,json; d=json.load(sys.stdin); d=d.get('data',d); print(next(p['id'] for p in d if p['key']=='org:sys_memberships:read'))")
existing=$(clerk api "/organization_roles?limit=100" |
  python3 -c "import sys,json; d=json.load(sys.stdin); print(' '.join(r['key'] for r in d.get('data',d)))")

create_role() { # key name description
  if [[ " $existing " == *" $1 "* ]]; then echo "• Role $1 exists"; return; fi
  echo "• Creating role $1"
  id=$(clerk api /organization_roles -d "{\"key\":\"$1\",\"name\":\"$2\",\"description\":\"$3\"}" --yes |
    python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
  clerk api "/organization_roles/$id/permissions/$perm_id" -X POST --yes >/dev/null
}
create_role org:editor Editor "Design, comment, run the agent and LLM exports"
create_role org:viewer Viewer "View-only: view designs and run deterministic exports"

echo "• Default role for new members: org:viewer"
clerk api /role_sets/role_set:default -X PATCH -d '{"default_role_key":"org:viewer"}' --yes >/dev/null
echo "Done."
