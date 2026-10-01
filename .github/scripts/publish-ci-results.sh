#!/usr/bin/env bash
# Publish a CI run's screenshots and logs to the `ci-results` branch, so they
# can be read with plain git (`git fetch origin ci-results`) without opening
# the Actions UI — useful because this repository is private and its Actions
# API needs a token.
#
#   publish-ci-results.sh <name> <source-dir> <status>
#
# Each (branch, name) pair keeps only its latest run under
# <branch-with-slashes-as-dashes>/<name>/; RUN.md says which commit and run.
set -euo pipefail

NAME="$1"
SRC="$2"
STATUS="${3:-unknown}"

: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
REF="${GITHUB_HEAD_REF:-${GITHUB_REF_NAME:-local}}"
SLUG="$(printf '%s' "$REF" | tr '/' '-' | tr -cd 'A-Za-z0-9._-')"
DEST="$SLUG/$NAME"
REMOTE="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID:-0}"
SHA="${PR_HEAD_SHA:-${GITHUB_SHA:-unknown}}"

WORK="$(mktemp -d)"
if git ls-remote --exit-code --heads "$REMOTE" ci-results >/dev/null 2>&1; then
  git clone -q --depth 1 --branch ci-results "$REMOTE" "$WORK"
else
  git init -q "$WORK"
  git -C "$WORK" checkout -q --orphan ci-results
  git -C "$WORK" remote add origin "$REMOTE"
  printf '# CI results\n\nLatest screenshots and logs per branch, written by .github/scripts/publish-ci-results.sh.\n' > "$WORK/README.md"
fi

rm -rf "${WORK:?}/$DEST"
mkdir -p "$WORK/$DEST"
if [ -d "$SRC" ]; then
  cp -R "$SRC"/. "$WORK/$DEST"/
fi
cat > "$WORK/$DEST/RUN.md" <<EOF
# $NAME — $STATUS

- branch: \`$REF\`
- commit: \`$SHA\`
- run: $RUN_URL
- finished: $(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

cd "$WORK"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A
if git diff --cached --quiet; then
  echo "nothing to publish"
  exit 0
fi
git commit -q -m "$NAME on $REF: $STATUS (${SHA:0:7})"
for attempt in 1 2 3; do
  if git push -q origin ci-results; then
    echo "published to ci-results:$DEST"
    exit 0
  fi
  git pull -q --rebase origin ci-results || true
  sleep $((attempt * 3))
done
echo "could not push ci-results" >&2
exit 1
