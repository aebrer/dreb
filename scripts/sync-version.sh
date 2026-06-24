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

# Surgically update workspace package versions in package-lock.json.
#
# We deliberately do NOT run `npm install --package-lock-only` here: that
# re-resolves the entire transitive dependency graph and can rewrite large,
# unrelated portions of the lockfile (and differs between npm versions),
# producing noisy diffs on every build/version bump. Instead we edit only the
# `version` fields for the root and our top-level workspace packages, leaving
# the rest of the dependency graph byte-for-byte unchanged.
#
# Dependency changes still require an intentional `npm install` to refresh the
# lockfile — that is a separate, explicit operation from a version bump.
if [ -f package-lock.json ]; then
	node -e "
		const fs = require('fs');
		const version = '$VERSION';
		const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf-8'));

		// Top-level workspace packages we just bumped (direct children of packages/).
		// Mirrors the 'packages/*/package.json' glob above and excludes nested
		// example extensions, which carry independent versions.
		const dirs = fs.readdirSync('packages').filter((name) => {
			try {
				return fs.statSync('packages/' + name + '/package.json').isFile();
			} catch {
				return false;
			}
		});

		let changed = 0;
		const setVersion = (key) => {
			const entry = lock.packages && lock.packages[key];
			if (entry && entry.version !== undefined && entry.version !== version) {
				entry.version = version;
				changed++;
			}
		};

		if (lock.version !== version) {
			lock.version = version;
			changed++;
		}
		setVersion('');
		for (const dir of dirs) setVersion('packages/' + dir);

		// Preserve the existing tab indentation + trailing newline npm writes.
		fs.writeFileSync('package-lock.json', JSON.stringify(lock, null, '\t') + '\n');
		console.log('  package-lock.json workspace versions updated (' + changed + ' field(s))');
	"
else
	echo "  package-lock.json not found, skipping lockfile version sync"
fi

echo "Done. Files to stage for version bump commit:"
echo "  package.json"
echo "  package-lock.json"
for pkg in packages/*/package.json; do echo "  $pkg"; done
for pj in packages/*/.claude-plugin/plugin.json; do [ -f "$pj" ] && echo "  $pj"; done
