#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEAM_REPOS_FILE="${TEAM_REPOS_FILE:-${SCRIPT_DIR}/linear-team-repos.json}"

if [ -z "${INTERNAL_CALLBACK_SECRET:-}" ]; then
  echo "INTERNAL_CALLBACK_SECRET is required" >&2
  exit 1
fi

if [ -z "${LINEAR_BOT_URL:-}" ]; then
  if [ -z "${DEPLOYMENT_NAME:-}" ] || [ -z "${CLOUDFLARE_WORKER_SUBDOMAIN:-}" ]; then
    echo "Set LINEAR_BOT_URL or both DEPLOYMENT_NAME and CLOUDFLARE_WORKER_SUBDOMAIN" >&2
    exit 1
  fi
  LINEAR_BOT_URL="https://open-inspect-linear-bot-${DEPLOYMENT_NAME}.${CLOUDFLARE_WORKER_SUBDOMAIN}.workers.dev"
fi

if [ ! -f "$TEAM_REPOS_FILE" ]; then
  echo "Team repos file not found: $TEAM_REPOS_FILE" >&2
  exit 1
fi

TIMESTAMP=$(node -e 'console.log(Date.now())')
SIGNATURE=$(printf '%s' "$TIMESTAMP" | openssl dgst -sha256 -hmac "$INTERNAL_CALLBACK_SECRET" -hex | awk '{print $NF}')

curl -fsS -X PUT "${LINEAR_BOT_URL}/config/team-repos" \
  -H "Authorization: Bearer ${TIMESTAMP}.${SIGNATURE}" \
  -H "Content-Type: application/json" \
  -d @"${TEAM_REPOS_FILE}"

echo "Updated team repos at ${LINEAR_BOT_URL}/config/team-repos"
