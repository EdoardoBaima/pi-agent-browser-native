export type AgentBrowserCommandResolutionKind = "fallback" | "path-exe" | "npm-cmd-shim";

export interface AgentBrowserCommandResolution {
	command: string;
	resolution: AgentBrowserCommandResolutionKind;
	shimPath?: string;
}

export interface ResolveAgentBrowserCommandOptions {
	commandName?: string;
	env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
	pathExists?: (path: string) => boolean | Promise<boolean>;
	pathValue?: string;
	platform?: NodeJS.Platform;
	readText?: (path: string) => string | Promise<string>;
}

export function getSearchPathValue(env?: NodeJS.ProcessEnv | Record<string, string | undefined>): string;
export function splitSearchPath(pathValue?: string, platform?: NodeJS.Platform): string[];
export function resolveWindowsNpmCmdShimTargetPath(shimPath: string, shimText: string): string | undefined;
export function resolveAgentBrowserCommand(options?: ResolveAgentBrowserCommandOptions): Promise<AgentBrowserCommandResolution>;
