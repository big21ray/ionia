#!/bin/bash
set -euo pipefail

REPO_DIR="/opt/ionia"
BRANCH="${1:-main}"

echo "=== DEPLOY START ==="
echo "Repo dir: $REPO_DIR"
echo "Branch:   $BRANCH"

cd "$REPO_DIR"

echo "Current branch before:"
git branch --show-current || true

echo "Fetching branch from origin..."
git fetch origin "$BRANCH"

echo "Checking out branch..."
git checkout "$BRANCH"

echo "Resetting to origin/$BRANCH"
git reset --hard "origin/$BRANCH"

echo "Current HEAD after:"
git log -1 --oneline

echo "Testing nginx config..."
nginx -t

echo "Reloading nginx..."
systemctl reload nginx

echo "=== DEPLOY DONE ==="
