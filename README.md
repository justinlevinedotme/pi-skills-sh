# pi-skills-sh

A [pi](https://github.com/badlogic/pi-mono) extension that brings [skills.sh](https://skills.sh) into your pi session. Browse, search, install, remove, and update agent skills without leaving your terminal.

## Install

```bash
# From npm
pi install npm:pi-skills-sh

# From git
pi install git:github.com/justinlevinedotme/pi-skills-sh
```

Or try without installing:

```bash
pi -e npm:pi-skills-sh
```

## Usage

All commands are accessed via `/skills`:

| Command | Description |
|---------|-------------|
| `/skills` | Interactive search prompt |
| `/skills find <query>` | Search skills.sh by keyword |
| `/skills add <owner/repo>` | Browse & install skills from a repo |
| `/skills add <owner/repo@skill>` | Install a specific skill directly |
| `/skills list` | List installed pi skills (global + project) |
| `/skills remove` | Interactive removal |
| `/skills remove <name>` | Remove a specific skill |
| `/skills update` | Update all installed skills |

### Examples

```
/skills find react
/skills add vercel-labs/agent-skills
/skills add anthropics/skills@frontend-design
/skills list
/skills remove frontend-design
/skills update
```

## How it works

This extension wraps the [`npx skills`](https://github.com/vercel-labs/skills) CLI, targeting the `pi` agent. Skills are installed to:

- **Global:** `~/.pi/agent/skills/` (available in all projects)
- **Project:** `.pi/skills/` (local to the current project)

After installing or removing a skill, the extension offers to `/reload` so pi picks up the changes immediately.

## Requirements

- [pi](https://github.com/badlogic/pi-mono) coding agent
- Node.js (for `npx skills`)

## License

MIT
