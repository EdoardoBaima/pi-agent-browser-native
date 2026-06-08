export type AgentBrowserInvocationResolutionKind = "fallback" | "path-exe" | "npm-cmd-shim" | "node-cmd-shim";

export interface AgentBrowserInvocationResolution {
	argsPrefix?: string[];
	command: string;
	resolution: AgentBrowserInvocationResolutionKind;
	shimPath?: string;
}

export interface ResolveAgentBrowserInvocationOptions {
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
export function resolveAgentBrowserInvocation(options?: ResolveAgentBrowserInvocationOptions): Promise<AgentBrowserInvocationResolution>;
