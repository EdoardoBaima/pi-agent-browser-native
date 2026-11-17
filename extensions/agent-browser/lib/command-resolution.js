// @ts-check

/**
 * Purpose: Resolve the upstream agent-browser executable without invoking a shell.
 * Responsibilities: Preserve the plain command on non-Windows hosts, prefer real Windows .exe binaries on PATH, and unwrap narrow npm/fnm .cmd shims into direct spawn invocations.
 * Scope: Command invocation lookup only; process spawning, env curation, and result handling live in process.ts and doctor.mjs.
 * Invariants/Assumptions: This package targets the current upstream agent-browser install layout and does not execute .cmd files through cmd.exe.
 */

import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { env as processEnv, platform as processPlatform } from "node:process";

/** @typedef {"fallback" | "path-exe" | "npm-cmd-shim" | "node-cmd-shim"} AgentBrowserInvocationResolutionKind */
/** @typedef {{ argsPrefix?: string[]; command: string; resolution: AgentBrowserInvocationResolutionKind; shimPath?: string }} AgentBrowserInvocationResolution */
/** @typedef {NodeJS.ProcessEnv | Record<string, string | undefined>} SearchEnv */
/** @typedef {(path: string) => boolean | Promise<boolean>} PathExists */
/** @typedef {(path: string) => string | Promise<string>} ReadText */
/** @typedef {{ commandName?: string; env?: SearchEnv; pathExists?: PathExists; pathValue?: string; platform?: NodeJS.Platform; readText?: ReadText }} ResolveAgentBrowserInvocationOptions */

const AGENT_BROWSER_COMMAND = "agent-browser";
const WINDOWS_NATIVE_AGENT_BROWSER_EXE_PATTERN = /%~dp0([^"'\r\n]*agent-browser-win32-x64\.exe)/i;

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function defaultPathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * @param {string} path
 * @returns {Promise<string>}
 */
async function defaultReadText(path) {
	return await readFile(path, "utf8");
}

/**
 * @param {SearchEnv | undefined} env
 * @param {string} name
 * @returns {string | undefined}
 */
function getEnvValue(env, name) {
	if (!env) return undefined;
	if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
	const normalizedName = name.toLowerCase();
	for (const [key, value] of Object.entries(env)) {
		if (key.toLowerCase() === normalizedName) return value;
	}
	return undefined;
}

/**
 * @param {SearchEnv} [env]
 * @returns {string}
 */
export function getSearchPathValue(env = processEnv) {
	return getEnvValue(env, "PATH") ?? "";
}

/**
 * @param {string} [pathValue]
 * @param {NodeJS.Platform} [platform]
 * @returns {string[]}
 */
export function splitSearchPath(pathValue, platform = processPlatform) {
	const separator = platform === "win32" ? ";" : ":";
	return String(pathValue ?? "")
		.split(separator)
		.map((entry) => entry.trim())
		.map((entry) => entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry)
		.filter(Boolean);
}

/** @param {string} path */
function isAbsoluteLikePath(path) {
	return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(String(path ?? ""));
}

/** @param {string} token */
function isPathLikeCmdShimToken(token) {
	return /^%~dp0/i.test(String(token ?? "")) || isAbsoluteLikePath(token) || /[\\/]/.test(String(token ?? ""));
}

/**
 * @param {string} shimPath
 * @param {string} token
 * @returns {string | undefined}
 */
function resolveCmdShimPathToken(shimPath, token) {
	const text = String(token ?? "");
	if (/^%~dp0/i.test(text)) {
		const relativePath = text.replace(/^%~dp0[\\/]*/i, "");
		const targetSegments = relativePath.split(/[\\/]+/).filter(Boolean);
		if (targetSegments.length === 0) return undefined;
		return join(dirname(shimPath), ...targetSegments);
	}
	if (isAbsoluteLikePath(text)) return text;
	const targetSegments = text.split(/[\\/]+/).filter(Boolean);
	if (targetSegments.length === 0) return undefined;
	return join(dirname(shimPath), ...targetSegments);
}

/**
 * @param {string} shimText
 * @returns {string[]}
 */
function getExecutableCmdLines(shimText) {
	return String(shimText ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.filter((line) => !/^@?echo\s+off\b/i.test(line));
}

/**
 * @param {string} shimText
 * @returns {{ command: string; script: string } | undefined}
 */
function parseNodeForwardingCmdShim(shimText) {
	const commandLines = getExecutableCmdLines(shimText);
	if (commandLines.length !== 1) return undefined;
	const match = /^@?"([^"]+)"\s+"([^"]+)"\s+%\*\s*$/i.exec(commandLines[0]);
	if (!match) return undefined;
	const [, command, script] = match;
	const commandBasename = command.split(/[\\/]+/).filter(Boolean).pop()?.toLowerCase();
	if (commandBasename !== "node.exe" && commandBasename !== "node") return undefined;
	return { command, script };
}

/**
 * @param {string} shimPath
 * @param {string} shimText
 * @returns {string | undefined}
 */
export function resolveWindowsNpmCmdShimTargetPath(shimPath, shimText) {
	const match = WINDOWS_NATIVE_AGENT_BROWSER_EXE_PATTERN.exec(String(shimText ?? ""));
	if (!match) return undefined;
	const relativeTarget = match[1].replace(/^[\\/]+/, "");
	const targetSegments = relativeTarget.split(/[\\/]+/).filter(Boolean);
	if (targetSegments.length === 0) return undefined;
	return join(dirname(shimPath), ...targetSegments);
}

/**
 * @param {string} shimPath
 * @param {string} shimText
 * @param {{ pathExists?: PathExists }} [options]
 * @returns {Promise<AgentBrowserInvocationResolution | undefined>}
 */
async function resolveWindowsNodeCmdShimInvocation(shimPath, shimText, options = {}) {
	const parsed = parseNodeForwardingCmdShim(shimText);
	if (!parsed) return undefined;
	const pathExists = options.pathExists ?? defaultPathExists;
	const scriptPath = resolveCmdShimPathToken(shimPath, parsed.script);
	if (!scriptPath || !(await pathExists(scriptPath))) return undefined;
	const command = isPathLikeCmdShimToken(parsed.command) ? resolveCmdShimPathToken(shimPath, parsed.command) : parsed.command;
	if (!command || (isPathLikeCmdShimToken(parsed.command) && !(await pathExists(command)))) return undefined;
	return { argsPrefix: [scriptPath], command, resolution: "node-cmd-shim", shimPath };
}

/**
 * @param {ResolveAgentBrowserInvocationOptions} [options]
 * @returns {Promise<AgentBrowserInvocationResolution>}
 */
export async function resolveAgentBrowserInvocation(options = {}) {
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
		/** @type {string} */
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
		const nodeInvocation = await resolveWindowsNodeCmdShimInvocation(cmdPath, shimText, { pathExists });
		if (nodeInvocation) return nodeInvocation;
	}

	return { command: commandName, resolution: "fallback" };
}
