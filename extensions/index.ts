/**
 * skills-sh - Browse, install, and manage skills.sh skills from inside pi
 *
 * Commands:
 *   /skills           - Interactive search & install
 *   /skills find      - Search skills by keyword
 *   /skills add       - Add a skill package (owner/repo)
 *   /skills list      - List installed skills
 *   /skills remove    - Remove installed skills
 *   /skills update    - Update all installed skills
 *
 * Uses the `npx skills` CLI under the hood, targeting the `pi` agent.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Strip ANSI escape codes from CLI output */
function stripAnsi(str: string): string {
	return str.replace(/\x1B\[[0-9;]*[a-zA-Z]|\x1B\].*?\x07|\x1B\[.*?[A-Za-z]|\[(\?25[hl]|999D|J)]/g, "");
}

/** Run `npx skills ...` and return { stdout, stderr, code } */
async function runSkills(
	pi: ExtensionAPI,
	args: string[],
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
	const result = await pi.exec("npx", ["skills", ...args], {
		signal,
		timeout: 60_000,
		env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
	});
	return {
		stdout: stripAnsi(result.stdout ?? ""),
		stderr: stripAnsi(result.stderr ?? ""),
		code: result.code ?? 1,
	};
}

// ── Parsers ──────────────────────────────────────────────────────────────────

interface SearchResult {
	id: string; // owner/repo@skill
	name: string;
	installs: string;
	url: string;
}

function parseSearchResults(output: string): SearchResult[] {
	const results: SearchResult[] = [];
	const lines = output.split("\n").filter((l) => l.trim());

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		// Match: owner/repo@skill-name  123.4K installs
		const match = line.match(/^(\S+\/\S+@\S+)\s+([\d.]+K?\s*installs?)$/i);
		if (match) {
			const id = match[1];
			const installs = match[2];
			const name = id.split("@").pop() ?? id;
			const url = lines[i + 1]?.trim().replace(/^└\s*/, "") ?? "";
			results.push({ id, name, installs, url });
		}
	}
	return results;
}

interface InstalledSkill {
	name: string;
	path: string;
	agents: string;
}

function parseListOutput(output: string): InstalledSkill[] {
	const skills: InstalledSkill[] = [];
	const lines = output.split("\n").filter((l) => l.trim());

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		// Match: skill-name  ~/.pi/agent/skills/skill-name
		const match = line.match(/^(\S+)\s+(~?\/.+)$/);
		if (match) {
			const agentsLine = lines[i + 1]?.trim() ?? "";
			const agentsMatch = agentsLine.match(/^Agents:\s*(.+)$/);
			skills.push({
				name: match[1],
				path: match[2],
				agents: agentsMatch?.[1] ?? "Pi",
			});
		}
	}
	return skills;
}

interface RepoSkill {
	name: string;
	description: string;
}

function parseRepoSkills(output: string): RepoSkill[] {
	const skills: RepoSkill[] = [];
	const lines = output.split("\n");

	let currentName: string | null = null;
	for (const line of lines) {
		const trimmed = line.trim();
		// Skill names appear on their own line, descriptions follow indented
		if (trimmed && !trimmed.startsWith("─") && !trimmed.startsWith("│") && !trimmed.startsWith("└") && !trimmed.startsWith("◇") && !trimmed.startsWith("◆") && !trimmed.startsWith("skills") && !trimmed.startsWith("Tip:") && !trimmed.startsWith("Source:") && !trimmed.startsWith("Use --") && !trimmed.startsWith("Found") && !trimmed.startsWith("Repository") && !trimmed.startsWith("Available") && !trimmed.startsWith("Cloning") && !trimmed.includes("███")) {
			if (currentName === null) {
				// This might be a skill name (short, no spaces in typical skill names)
				if (trimmed.length < 80 && !trimmed.includes("  ")) {
					currentName = trimmed;
				}
			} else {
				// This is the description
				skills.push({ name: currentName, description: trimmed });
				currentName = null;
			}
		} else {
			currentName = null;
		}
	}
	return skills;
}

// ── Subcommands ──────────────────────────────────────────────────────────────

async function skillsFind(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext) {
	const query = args.trim();
	if (!query) {
		ctx.ui.notify("Usage: /skills find <query>", "warning");
		return;
	}

	// Search with loader
	const searchResult = await ctx.ui.custom<SearchResult[] | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Searching skills.sh for "${query}"...`);
		loader.onAbort = () => done(null);

		runSkills(pi, ["find", query], loader.signal)
			.then((result) => {
				if (loader.signal.aborted) return;
				const parsed = parseSearchResults(result.stdout);
				done(parsed);
			})
			.catch(() => done(null));

		return loader;
	});

	if (!searchResult) {
		ctx.ui.notify("Search cancelled", "info");
		return;
	}

	if (searchResult.length === 0) {
		ctx.ui.notify(`No skills found for "${query}"`, "info");
		return;
	}

	// Let user pick a skill
	const items = searchResult.map((s) => `${s.name}  (${s.installs}) — ${s.id}`);
	const selected = await ctx.ui.select(`Found ${searchResult.length} skills for "${query}"`, items);

	if (!selected) return;

	const idx = items.indexOf(selected);
	const skill = searchResult[idx];

	// Offer to install
	const install = await ctx.ui.confirm(`Install ${skill.name}?`, `From: ${skill.id}\n${skill.url}`);
	if (!install) return;

	await installSkill(pi, skill.id, ctx);
}

async function skillsAdd(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext) {
	const source = args.trim();
	if (!source) {
		ctx.ui.notify("Usage: /skills add <owner/repo>  or  /skills add <owner/repo@skill>", "warning");
		return;
	}

	// If source includes @, it's a direct skill reference — install directly
	if (source.includes("@")) {
		await installSkill(pi, source, ctx);
		return;
	}

	// Otherwise, list available skills in the repo first
	const repoSkills = await ctx.ui.custom<RepoSkill[] | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Listing skills in ${source}...`);
		loader.onAbort = () => done(null);

		runSkills(pi, ["add", source, "--list"], loader.signal)
			.then((result) => {
				if (loader.signal.aborted) return;
				const parsed = parseRepoSkills(result.stdout);
				done(parsed);
			})
			.catch(() => done(null));

		return loader;
	});

	if (!repoSkills) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}

	if (repoSkills.length === 0) {
		// Fallback: try installing the whole repo
		const ok = await ctx.ui.confirm("No individual skills found", `Install all from ${source}?`);
		if (ok) {
			await installSkill(pi, source, ctx);
		}
		return;
	}

	// Let user select which skills to install
	const items = repoSkills.map((s) => `${s.name} — ${s.description.slice(0, 80)}`);
	items.unshift("★ Install ALL skills");
	const selected = await ctx.ui.select(`Skills in ${source}`, items);

	if (!selected) return;

	if (selected.startsWith("★")) {
		await installSkill(pi, source, ctx, "*");
	} else {
		const idx = items.indexOf(selected) - 1; // -1 for the "Install ALL" option
		const skill = repoSkills[idx];
		await installSkill(pi, source, ctx, skill.name);
	}
}

async function installSkill(pi: ExtensionAPI, source: string, ctx: ExtensionCommandContext, skillName?: string) {
	// Ask scope
	const scope = await ctx.ui.select("Install scope", [
		"Global — available in all projects (~/.pi/agent/skills/)",
		"Project — local to this project (.pi/skills/)",
	]);

	if (!scope) return;

	const isGlobal = scope.startsWith("Global");
	const flagArgs = ["-a", "pi", "-y"];
	if (isGlobal) flagArgs.push("-g");
	if (skillName) flagArgs.push("-s", skillName);

	const label = skillName ? `${source} → ${skillName}` : source;

	const installResult = await ctx.ui.custom<{ ok: boolean; output: string } | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Installing ${label}...`);
		loader.onAbort = () => done(null);

		runSkills(pi, ["add", source, ...flagArgs], loader.signal)
			.then((result) => {
				if (loader.signal.aborted) return;
				done({ ok: result.code === 0, output: result.stdout + result.stderr });
			})
			.catch((err) => done({ ok: false, output: String(err) }));

		return loader;
	});

	if (!installResult) {
		ctx.ui.notify("Installation cancelled", "info");
		return;
	}

	if (installResult.ok) {
		ctx.ui.notify(`✓ Installed ${label} (${isGlobal ? "global" : "project"})`, "info");
		// Prompt to reload so pi picks up the new skill
		const reload = await ctx.ui.confirm("Reload?", "Reload pi to activate the new skill?");
		if (reload) {
			await ctx.reload();
			return;
		}
	} else {
		ctx.ui.notify(`✗ Failed to install ${label}`, "error");
		// Show truncated error output
		const lines = installResult.output.split("\n").filter((l) => l.trim()).slice(0, 10);
		for (const line of lines) {
			ctx.ui.notify(line, "error");
		}
	}
}

async function skillsList(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext) {
	const isGlobal = args.trim() === "-g" || args.trim() === "global" || args.trim() === "";
	const isProject = args.trim() === "project" || args.trim() === "-l";

	const listArgs = ["-a", "pi"];
	// List both scopes unless specifically asked for one
	if (isProject) {
		// project only (no -g)
	} else if (isGlobal && args.trim()) {
		listArgs.push("-g");
	} else {
		// show both: run twice
	}

	const result = await ctx.ui.custom<InstalledSkill[] | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, "Loading installed skills...");
		loader.onAbort = () => done(null);

		const fetchBoth = async () => {
			const globalResult = await runSkills(pi, ["list", "-g", "-a", "pi"], loader.signal);
			const projectResult = await runSkills(pi, ["list", "-a", "pi"], loader.signal);
			if (loader.signal.aborted) return;

			const globalSkills = parseListOutput(globalResult.stdout).map((s) => ({ ...s, agents: "Global" }));
			const projectSkills = parseListOutput(projectResult.stdout).map((s) => ({ ...s, agents: "Project" }));
			done([...globalSkills, ...projectSkills]);
		};

		fetchBoth().catch(() => done(null));
		return loader;
	});

	if (!result) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}

	if (result.length === 0) {
		ctx.ui.notify("No pi skills installed. Use /skills find <query> to discover skills.", "info");
		return;
	}

	const items = result.map((s) => `${s.name}  [${s.agents}]  ${s.path}`);
	const selected = await ctx.ui.select(`Installed Pi Skills (${result.length})`, items);

	if (!selected) return;

	const idx = items.indexOf(selected);
	const skill = result[idx];

	const action = await ctx.ui.select(skill.name, ["View SKILL.md", "Remove skill", "Cancel"]);
	if (action === "View SKILL.md") {
		// Read the SKILL.md and put it in the editor for the user to see
		const skillPath = skill.path.replace("~", process.env.HOME ?? "~");
		try {
			const { readFile } = await import("node:fs/promises");
			const content = await readFile(`${skillPath}/SKILL.md`, "utf-8");
			ctx.ui.setEditorText(`/skill:${skill.name}\n\n--- SKILL.md preview ---\n${content.slice(0, 500)}`);
			ctx.ui.notify(`Loaded ${skill.name} SKILL.md preview into editor`, "info");
		} catch {
			ctx.ui.notify(`Could not read ${skillPath}/SKILL.md`, "error");
		}
	} else if (action === "Remove skill") {
		await skillsRemoveSingle(pi, skill.name, skill.agents === "Global", ctx);
	}
}

async function skillsRemove(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext) {
	const skillName = args.trim();

	if (skillName) {
		// Direct removal
		const scope = await ctx.ui.select(`Remove ${skillName} from:`, ["Global", "Project", "Cancel"]);
		if (!scope || scope === "Cancel") return;
		await skillsRemoveSingle(pi, skillName, scope === "Global", ctx);
		return;
	}

	// Interactive: list installed skills, let user pick
	const result = await ctx.ui.custom<InstalledSkill[] | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, "Loading installed skills...");
		loader.onAbort = () => done(null);

		const fetchBoth = async () => {
			const globalResult = await runSkills(pi, ["list", "-g", "-a", "pi"], loader.signal);
			const projectResult = await runSkills(pi, ["list", "-a", "pi"], loader.signal);
			if (loader.signal.aborted) return;

			const globalSkills = parseListOutput(globalResult.stdout).map((s) => ({ ...s, agents: "Global" }));
			const projectSkills = parseListOutput(projectResult.stdout).map((s) => ({ ...s, agents: "Project" }));
			done([...globalSkills, ...projectSkills]);
		};

		fetchBoth().catch(() => done(null));
		return loader;
	});

	if (!result || result.length === 0) {
		ctx.ui.notify("No skills to remove", "info");
		return;
	}

	const items = result.map((s) => `${s.name}  [${s.agents}]`);
	const selected = await ctx.ui.select("Select skill to remove", items);
	if (!selected) return;

	const idx = items.indexOf(selected);
	const skill = result[idx];
	await skillsRemoveSingle(pi, skill.name, skill.agents === "Global", ctx);
}

async function skillsRemoveSingle(pi: ExtensionAPI, name: string, isGlobal: boolean, ctx: ExtensionCommandContext) {
	const ok = await ctx.ui.confirm("Remove skill?", `Remove ${name} from ${isGlobal ? "global" : "project"} scope?`);
	if (!ok) return;

	const removeArgs = [name, "-a", "pi", "-y"];
	if (isGlobal) removeArgs.push("-g");

	const result = await ctx.ui.custom<{ ok: boolean; output: string } | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Removing ${name}...`);
		loader.onAbort = () => done(null);

		runSkills(pi, ["remove", ...removeArgs], loader.signal)
			.then((r) => {
				if (loader.signal.aborted) return;
				done({ ok: r.code === 0, output: r.stdout + r.stderr });
			})
			.catch((err) => done({ ok: false, output: String(err) }));

		return loader;
	});

	if (!result) return;

	if (result.ok) {
		ctx.ui.notify(`✓ Removed ${name}`, "info");
		const reload = await ctx.ui.confirm("Reload?", "Reload pi to update available skills?");
		if (reload) {
			await ctx.reload();
			return;
		}
	} else {
		ctx.ui.notify(`✗ Failed to remove ${name}`, "error");
	}
}

async function skillsUpdate(pi: ExtensionAPI, _args: string, ctx: ExtensionCommandContext) {
	const result = await ctx.ui.custom<{ ok: boolean; output: string } | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, "Updating all installed skills...");
		loader.onAbort = () => done(null);

		runSkills(pi, ["update"], loader.signal)
			.then((r) => {
				if (loader.signal.aborted) return;
				done({ ok: r.code === 0, output: r.stdout + r.stderr });
			})
			.catch((err) => done({ ok: false, output: String(err) }));

		return loader;
	});

	if (!result) {
		ctx.ui.notify("Update cancelled", "info");
		return;
	}

	if (result.ok) {
		ctx.ui.notify("✓ Skills updated", "info");
		const reload = await ctx.ui.confirm("Reload?", "Reload pi to apply updates?");
		if (reload) {
			await ctx.reload();
			return;
		}
	} else {
		ctx.ui.notify("✗ Update failed", "error");
		const lines = result.output.split("\n").filter((l) => l.trim()).slice(0, 5);
		for (const line of lines) {
			ctx.ui.notify(line, "error");
		}
	}
}

// ── Main Extension ───────────────────────────────────────────────────────────

export default function skillsShExtension(pi: ExtensionAPI) {
	pi.registerCommand("skills", {
		description: "Browse, install & manage skills.sh skills",
		getArgumentCompletions: (prefix) => {
			const subcommands = [
				{ value: "find ", label: "find", description: "Search skills by keyword" },
				{ value: "add ", label: "add", description: "Add a skill (owner/repo)" },
				{ value: "list", label: "list", description: "List installed skills" },
				{ value: "remove ", label: "remove", description: "Remove a skill" },
				{ value: "update", label: "update", description: "Update all skills" },
			];
			const filtered = subcommands.filter((s) => s.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("skills-sh requires interactive mode", "error");
				return;
			}

			const trimmed = args.trim();

			// Parse subcommand
			if (trimmed.startsWith("find ") || trimmed === "find") {
				await skillsFind(pi, trimmed.slice(5), ctx);
			} else if (trimmed.startsWith("add ") || trimmed === "add") {
				await skillsAdd(pi, trimmed.slice(4), ctx);
			} else if (trimmed.startsWith("list") || trimmed === "ls") {
				await skillsList(pi, trimmed.slice(4), ctx);
			} else if (trimmed.startsWith("remove ") || trimmed === "remove" || trimmed === "rm") {
				const removeArgs = trimmed.startsWith("remove ") ? trimmed.slice(7) : trimmed === "rm" ? "" : trimmed.slice(6);
				await skillsRemove(pi, removeArgs, ctx);
			} else if (trimmed === "update") {
				await skillsUpdate(pi, "", ctx);
			} else if (trimmed === "") {
				// Default: interactive search
				const query = await ctx.ui.input("Search skills.sh:", "e.g. react, seo, typescript...");
				if (query) {
					await skillsFind(pi, query, ctx);
				}
			} else {
				// Assume it's a search query
				await skillsFind(pi, trimmed, ctx);
			}
		},
	});
}
