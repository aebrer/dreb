#!/usr/bin/env bash
# Sync version from root package.json to all workspace packages.
# Usage: ./scripts/sync-version.sh [version]
# If version is provided, sets root first. Otherwise reads from root.

set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -ge 1 ]; then
	# Set version in root package.json
	node -e "
		const fs = require('fs');
		const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
		pkg.version = '$1';
		fs.writeFileSync('package.json', JSON.stringify(pkg, null, '\t') + '\n');
	"
fi

VERSION=$(node -p "require('./package.json').version")
echo "Syncing version $VERSION to all packages..."

for pkg in packages/*/package.json; do
	node -e "
		const fs = require('fs');
		const pkg = JSON.parse(fs.readFileSync('$pkg', 'utf-8'));
		pkg.version = '$VERSION';
		fs.writeFileSync('$pkg', JSON.stringify(pkg, null, '\t') + '\n');
	"
	echo "  $pkg -> $VERSION"
done

# Sync .claude-plugin/plugin.json if present
for plugin_json in packages/*/.claude-plugin/plugin.json; do
	[ -f "$plugin_json" ] || continue
	node -e "
		const fs = require('fs');
		const p = JSON.parse(fs.readFileSync('$plugin_json', 'utf-8'));
		p.version = '$VERSION';
		fs.writeFileSync('$plugin_json', JSON.stringify(p, null, '  ') + '\n');
	"
	echo "  $plugin_json -> $VERSION"
done

# Refresh package-lock.json so workspace versions match
npm install --package-lock-only --ignore-scripts --install-links=false 2>/dev/null
echo "  package-lock.json refreshed"

echo "Done. Files to stage for version bump commit:"
echo "  package.json"
echo "  package-lock.json"
for pkg in packages/*/package.json; do echo "  $pkg"; done
for pj in packages/*/.claude-plugin/plugin.json; do [ -f "$pj" ] && echo "  $pj"; done
