/**
 * Purpose: Resolve the upstream agent-browser executable without invoking a shell.
 * Responsibilities: Preserve the plain command on non-Windows hosts, prefer real Windows .exe binaries on PATH, and unwrap npm/fnm .cmd shims that point at the current native agent-browser exe.
 * Scope: Command lookup only; process spawning, env curation, and result handling live in process.ts and doctor.mjs.
 * Invariants/Assumptions: This package targets the current upstream agent-browser install layout and does not execute .cmd files through cmd.exe.
 */

import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { env as processEnv, platform as processPlatform } from "node:process";

const AGENT_BROWSER_COMMAND = "agent-browser";
const WINDOWS_NATIVE_AGENT_BROWSER_EXE_PATTERN = /%~dp0([^"'\r\n]*agent-browser-win32-x64\.exe)/i;

async function defaultPathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function defaultReadText(path) {
	return await readFile(path, "utf8");
}

function getEnvValue(env, name) {
	if (!env) return undefined;
	if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
	const normalizedName = name.toLowerCase();
	for (const [key, value] of Object.entries(env)) {
		if (key.toLowerCase() === normalizedName) return value;
	}
	return undefined;
}

export function getSearchPathValue(env = processEnv) {
	return getEnvValue(env, "PATH") ?? "";
}

export function splitSearchPath(pathValue, platform = processPlatform) {
	const separator = platform === "win32" ? ";" : ":";
	return String(pathValue ?? "")
		.split(separator)
		.map((entry) => entry.trim())
		.map((entry) => entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry)
		.filter(Boolean);
}

export function resolveWindowsNpmCmdShimTargetPath(shimPath, shimText) {
	const match = WINDOWS_NATIVE_AGENT_BROWSER_EXE_PATTERN.exec(String(shimText ?? ""));
	if (!match) return undefined;
	const relativeTarget = match[1].replace(/^[\\/]+/, "");
	const targetSegments = relativeTarget.split(/[\\/]+/).filter(Boolean);
	if (targetSegments.length === 0) return undefined;
	return join(dirname(shimPath), ...targetSegments);
}

export async function resolveAgentBrowserCommand(options = {}) {
	const platform = options.platform ?? processPlatform;
	const commandName = options.commandName ?? AGENT_BROWSER_COMMAND;
	if (platform !== "win32") {
		return { command: commandName, resolution: "fallback" };
	}

	const pathExists = options.pathExists ?? defaultPathExists;
	const readText = options.readText ?? defaultReadText;
	const searchPath = options.pathValue ?? getSearchPathValue(options.env ?? processEnv);
	const searchDirs = splitSearchPath(searchPath, platform);

	for (const directory of searchDirs) {
		const exePath = join(directory, `${commandName}.exe`);
		if (await pathExists(exePath)) {
			return { command: exePath, resolution: "path-exe" };
		}
	}

	for (const directory of searchDirs) {
		const cmdPath = join(directory, `${commandName}.cmd`);
		if (!(await pathExists(cmdPath))) continue;
		let shimText;
		try {
			shimText = await readText(cmdPath);
		} catch {
			continue;
		}
		const targetPath = resolveWindowsNpmCmdShimTargetPath(cmdPath, shimText);
		if (targetPath && (await pathExists(targetPath))) {
			return { command: targetPath, resolution: "npm-cmd-shim", shimPath: cmdPath };
		}
	}

	return { command: commandName, resolution: "fallback" };
}
