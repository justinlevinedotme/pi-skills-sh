# pi-skills-sh

A pi extension that wraps the `npx skills` CLI to provide a `/skills` slash command for browsing, installing, and managing skills.sh skills.

## Project Structure

```
pi-skills-sh/
├── extensions/
│   └── index.ts          # The extension — registers /skills command
├── .github/workflows/
│   └── publish.yml       # Auto-publishes to npm on GitHub release
├── package.json          # Pi package manifest (pi.extensions field)
├── README.md
├── LICENSE
└── AGENTS.md
```

## Development

This is a single-file extension with no build step. Edit `extensions/index.ts` directly.

The extension uses only pi peer dependencies (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`) — no runtime deps to install.

To test locally:

```bash
pi -e ./extensions/index.ts
```

## Release Process

Releases are published to npm automatically via GitHub Actions when a GitHub release is created.

### Steps

1. **Bump the version** in `package.json` (follow semver):
   - Patch (`0.1.0` → `0.1.1`): bug fixes, parser tweaks
   - Minor (`0.1.0` → `0.2.0`): new subcommands, new features
   - Major (`0.x.x` → `1.0.0`): breaking changes

2. **Commit and push** the version bump:
   ```bash
   git add package.json
   git commit -m "chore: bump version to X.Y.Z"
   git push
   ```

3. **Create a GitHub release** with a changelog:
   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z" --notes "$(cat <<'EOF'
   ## What's Changed

   ### Added
   - New `/skills check` subcommand for checking updates

   ### Fixed
   - Fixed parser for skill names with colons (e.g. `react:components`)

   ### Changed
   - Improved error messages when `npx skills` is not available
   EOF
   )"
   ```

   The GitHub Action will automatically publish to npm.

### Changelog Format

Use [Keep a Changelog](https://keepachangelog.com/) categories:

- **Added** — new features or subcommands
- **Changed** — changes to existing behavior
- **Fixed** — bug fixes
- **Removed** — removed features
- **Security** — security-related changes

### Conventions

- Tag format: `vX.Y.Z` (e.g. `v0.2.0`)
- Commit messages: use conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`)
- The version in `package.json` must match the tag (without the `v` prefix)
- Always bump the version before creating the release

### Example: Full Release Flow

```bash
# 1. Make your changes
# 2. Bump version
npm version minor  # or patch/major — this updates package.json and creates a git tag

# 3. Push commit and tag
git push && git push --tags

# 4. Create the release on GitHub
gh release create v0.2.0 --title "v0.2.0" --generate-notes
```

Using `--generate-notes` auto-generates the changelog from commits since the last release. You can edit it before publishing if you want cleaner notes.

## Architecture Notes

- The extension shells out to `npx skills` rather than importing the skills CLI as a library. This keeps deps at zero and always uses the latest CLI version.
- All CLI output is parsed after stripping ANSI codes. The parsers are intentionally lenient — if the skills CLI changes its output format, parsers may need updating.
- The extension uses `BorderedLoader` for async operations (search, install, remove, update) so the user can cancel with Escape.
- After install/remove, the extension offers to `/reload` so pi picks up skill changes immediately.
