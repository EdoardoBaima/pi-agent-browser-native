/**
 * Purpose: Prove browser instruction composition and tool-result handling through the real Pi AgentSession pipeline.
 * Responsibilities: Use a model-free SDK session with a deterministic fake provider and fake upstream agent-browser binary, then inspect persisted tool results.
 * Scope: Pi integration coverage for extension event semantics that direct tool.execute() tests intentionally bypass.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import test from "node:test";


import {
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentSystemMessage,
	InMemoryCredentialStore,
	type Api,
	type JsonObject,
	type StreamFunction,
	type AssistantMessage,
	type TranscriptContext,
	type Model,
	type SimpleStreamOptions,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import agentBrowserExtension from "../extensions/agent-browser/index.js";
import {
	readInvocationLog,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

const PIPELINE_PROVIDER = "piab-pipeline";
const PIPELINE_MODEL_ID = "tool-pipeline";

type PipelineToolResult = ToolResultMessage & { toolName: "agent_browser" };

type PipelinePromptResult = {
	inMemoryResult: PipelineToolResult;
	invocations: Array<{ args: string[] }>;
	persistedResult: PipelineToolResult;
	sessionFile: string;
};

function isAgentBrowserToolResult(message: unknown): message is PipelineToolResult {
	return typeof message === "object" && message !== null &&
		(message as { role?: unknown }).role === "toolResult" &&
		(message as { toolName?: unknown }).toolName === "agent_browser";
}

function usage() {
	return {
		cacheRead: 0,
		cacheWrite: 0,
		cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
		input: 0,
		output: 0,
		totalTokens: 0,
	};
}

function createAssistantMessage(model: Model<Api>, stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		api: model.api,
		content: [],
		model: model.id,
		provider: model.provider,
		role: "assistant",
		stopReason,
		timestamp: Date.now(),
		usage: usage(),
	};
}

function streamTextResponse(model: Model<Api>, text: string) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const output = createAssistantMessage(model, "stop");
		stream.push({ type: "start", partial: output });
		output.content.push({ type: "text", text: "" });
		stream.push({ type: "text_start", contentIndex: 0, partial: output });
		const block = output.content[0];
		if (block?.type === "text") block.text = text;
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
		stream.push({ type: "done", reason: "stop", message: output });
		stream.end();
	});
	return stream;
}

function createToolCallingStream(toolArguments: JsonObject) {
	return (model: Model<Api>, context: TranscriptContext, _options?: SimpleStreamOptions) => {
		const hasToolResult = context.messages.some((message) => message.role === "toolResult" && message.toolName === "agent_browser");
		if (hasToolResult) return streamTextResponse(model, "Observed agent_browser result.");

		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const output = createAssistantMessage(model, "toolUse");
			const toolCall = {
				arguments: toolArguments,
				id: "call_agent_browser_pipeline",
				name: "agent_browser",
				type: "toolCall" as const,
			};
			stream.push({ type: "start", partial: output });
			output.content.push(toolCall);
			stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
			stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(toolArguments), partial: output });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
			stream.push({ type: "done", reason: "toolUse", message: output });
			stream.end();
		});
		return stream;
	};
}

function isSessionMessageEntry(value: unknown): value is { message?: unknown; type?: string } {
	return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "message";
}

async function listFilesRecursive(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...await listFilesRecursive(path));
		else files.push(path);
	}
	return files;
}

async function readPersistedAgentBrowserResult(sessionDir: string): Promise<{ result: PipelineToolResult; sessionFile: string }> {
	const sessionFiles = (await listFilesRecursive(sessionDir)).filter((path) => path.endsWith(".jsonl"));
	assert.equal(sessionFiles.length, 1, `expected one persisted session file, got ${sessionFiles.join(", ")}`);
	const sessionFile = sessionFiles[0];
	const lines = (await readFile(sessionFile, "utf8")).trim().split("\n").filter(Boolean);
	const results = lines
		.map((line) => JSON.parse(line) as unknown)
		.filter(isSessionMessageEntry)
		.map((entry) => entry.message)
		.filter(isAgentBrowserToolResult);
	const result = results.at(-1);
	assert.ok(result, "persisted session JSONL should include an agent_browser tool result");
	return { result, sessionFile };
}

function registerPipelineProvider(modelRuntime: ModelRuntime, streamSimple: StreamFunction<Api, SimpleStreamOptions>): Model<Api> {
	modelRuntime.registerProvider(PIPELINE_PROVIDER, {
		api: "openai-completions",
		apiKey: "piab-pipeline-key",
		baseUrl: "https://pipeline.example.test/v1",
		models: [{
			contextWindow: 128_000,
			cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
			id: PIPELINE_MODEL_ID,
			input: ["text"],
			maxTokens: 4096,
			name: "Pi Agent Browser Pipeline Test",
			reasoning: false,
		}],
		streamSimple,
	});
	const model = modelRuntime.getModel(PIPELINE_PROVIDER, PIPELINE_MODEL_ID);
	assert.ok(model, "pipeline test model should be registered");
	return model;
}

async function runPipelinePrompt(options: { fakeScript: string; toolArguments: JsonObject }): Promise<PipelinePromptResult> {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-pipeline-"));
	const sessionDir = join(tempDir, "sessions");
	const invocationLogPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`try { require("node:fs").appendFileSync(${JSON.stringify(invocationLogPath)}, JSON.stringify({ args: process.argv.slice(2) }) + "\\n"); } catch {}\n${options.fakeScript}`,
	);

	try {
		return await withPatchedEnv<PipelinePromptResult>({ PATH: `${tempDir}${delimiter}${basePath}`, HOME: tempDir, PI_AGENT_BROWSER_CONFIG: undefined, EXA_API_KEY: undefined, BRAVE_API_KEY: undefined }, async () => {
			const modelRuntime = await ModelRuntime.create({
				allowModelNetwork: false,
				credentials: new InMemoryCredentialStore(),
				modelsPath: null,
			});
			const model = registerPipelineProvider(modelRuntime, createToolCallingStream(options.toolArguments));
			const resourceLoader = new DefaultResourceLoader({
				agentDir: tempDir,
				cwd: tempDir,
				extensionFactories: [agentBrowserExtension],
				noContextFiles: true,
				noExtensions: true,
				noPromptTemplates: true,
				noSkills: true,
				noThemes: true,
			});
			await resourceLoader.reload();
			const { session } = await createAgentSession({
				cwd: tempDir,
				model,
				modelRuntime,
				noTools: "builtin",
				resourceLoader,
				sessionManager: SessionManager.create(tempDir, sessionDir, { id: "piab-pipeline-session" }),
				tools: ["agent_browser"],
			});
			try {
				await session.prompt("Use agent_browser once.");
				const inMemoryResult = session.messages.find(isAgentBrowserToolResult);
				assert.ok(inMemoryResult, "agent_browser tool result should be recorded by Pi");
				const persisted = await readPersistedAgentBrowserResult(sessionDir);
				return {
					inMemoryResult,
					invocations: await readInvocationLog(invocationLogPath),
					persistedResult: persisted.result,
					sessionFile: persisted.sessionFile,
				};
			} finally {
				session.dispose();
			}
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
}

test("Pi pipeline composes browser instructions without forcing the prompt across ordinary, snapshot, and browser turns", async (t) => {
	const cases = [
		{ name: "trusted project overrides global guidance", projectTrusted: true, noApprove: false, compiled: false },
		{ name: "untrusted project keeps global guidance", projectTrusted: false, noApprove: false, compiled: false },
		{ name: "no-approve excludes project config even when trusted", projectTrusted: true, noApprove: true, compiled: false },
		{ name: "compiled extension resolves package-root docs", projectTrusted: true, noApprove: false, compiled: true },
	];
	for (const scenario of cases) {
		await t.test(scenario.name, async () => {
			const root = await mkdtemp(join(tmpdir(), "piab-instruction-pipeline-"));
			const cwd = join(root, "repo");
			const home = join(root, "home");
			const projectConfigPath = join(cwd, ".pi", "config", "pi-agent-browser-native", "config.json");
			const originalArgv = process.argv;
			try {
				for (const [path, config] of [
					[join(home, ".pi", "config", "pi-agent-browser-native", "config.json"), {
						version: 1,
						browser: { defaultProfile: { name: "Global Profile", policy: "always" }, executablePath: "/global/browser" },
					}],
					[projectConfigPath, {
						version: 1,
						browser: { defaultProfile: { name: "Project Profile", policy: "always" }, executablePath: "/project/browser" },
						webSearch: { braveApiKey: "pipeline-unused-search-key" },
					}],
				] as const) {
					await mkdir(dirname(path), { recursive: true });
					await writeFile(path, JSON.stringify(config));
				}
				process.argv = [process.execPath, "pi", ...(scenario.noApprove ? ["--no-approve"] : [])];
				await withPatchedEnv({ HOME: home, PI_AGENT_BROWSER_CONFIG: undefined, EXA_API_KEY: undefined, BRAVE_API_KEY: undefined }, async () => {
					const requests: TranscriptContext[] = [];
					const observedForcing: Array<string | undefined> = [];
					const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, credentials: new InMemoryCredentialStore(), modelsPath: null });
					const model = registerPipelineProvider(modelRuntime, (model, context) => {
						requests.push(structuredClone(context));
						return streamTextResponse(model, "Acknowledged.");
					});
					const settingsManager = SettingsManager.inMemory({}, { projectTrusted: scenario.projectTrusted });
					let browserExtension: ExtensionFactory = agentBrowserExtension;
					if (scenario.compiled) {
						const compiledPath = resolve("dist/extensions/agent-browser/index.js");
						assert.ok(existsSync(compiledPath), "build the extension before running pipeline tests");
						browserExtension = (await import(pathToFileURL(compiledPath).href)).default;
					}
					const forcedPrompt = "Caller-owned forced system prompt.";
					const resourceLoader = new DefaultResourceLoader({
						agentDir: home, cwd, settingsManager,
						noContextFiles: true, noExtensions: true, noPromptTemplates: true, noSkills: true, noThemes: true,
						extensionFactories: [
							(pi) => { pi.on("before_agent_start", (event) => {
								event.systemPromptOptions.sections.pipeline_companion = `Companion instruction for: ${event.prompt}`;
								if (event.prompt === "Open the page with my custom prompt.") return { systemPrompt: forcedPrompt };
							}); },
							browserExtension,
							(pi) => { pi.on("before_agent_start", (event) => { observedForcing.push(event.systemPromptOptions.forceSystemPrompt); }); },
						],
					});
					await resourceLoader.reload();
					assert.deepEqual(resourceLoader.getExtensions().errors, []);
					const { session } = await createAgentSession({
						cwd, model, modelRuntime, settingsManager, resourceLoader,
						sessionManager: SessionManager.inMemory(cwd), noTools: "builtin",
					});
					try {
						await session.bindExtensions({});
						const projectAllowed = scenario.projectTrusted && !scenario.noApprove;
						assert.equal(session.getActiveToolNames().includes("agent_browser_web_search"), projectAllowed);
						const prompts = [
							"Please review the repository architecture.",
							"| Commit ID | Immutable snapshot produced by the commit |",
							"Open https://example.test and take a snapshot.",
						];
						for (const [index, prompt] of prompts.entries()) {
							await session.prompt(prompt);
							assert.equal(requests.length, index + 1, "each turn must reach the real provider boundary");
							assert.equal(observedForcing[index], undefined, "browser guidance must not force a whole-prompt replacement");
							const request = requests[index];
							const effective = getCurrentSystemPrompt(request.messages);
							const section = getCurrentSystemMessage(request.messages)?.sections?.agent_browser;
							assert.ok(section, "browser instructions must survive in the provider transcript as a named section");
							assert.equal(effective.split(section).length - 1, 1, "browser section must be composed exactly once");
							assert.equal(effective.split("agent_browser config sets browser.defaultProfile.name").length - 1, 1);
							assert.equal(effective.split("agent_browser config sets browser.executablePath").length - 1, 1);
							assert.match(section, projectAllowed ? /"Project Profile" with policy always/ : /"Global Profile" with policy always/);
							assert.ok(section.includes(projectAllowed ? "/project/browser" : "/global/browser"));
							assert.doesNotMatch(effective, projectAllowed ? /Global Profile|\/global\/browser/ : /Project Profile|\/project\/browser/);
							assert.match(section, /--executable-path/);
							assert.match(section, /profiles command still lists Chrome profiles only/);
							assert.match(section, /Common advanced calls:/);
							assert.match(section, /Standard workflow: open the page, snapshot -i/);
							assert.match(section, /If upstream reports tab_gone/);
							assert.equal(effective.split("Use agent_browser with one input mode:").length - 1, 1);
							if (projectAllowed) {
								assert.equal(effective.split("Prefer agent_browser_web_search for current or external web facts").length - 1, 1);
								assert.match(section, /searchType: deep-lite/);
								assert.match(section, /public search-engine forms that can hit anti-bot\/CAPTCHA-gated pages/);
								assert.match(section, /Use agent_browser after you have a target URL/);
								assert.match(section, /Do not run parallel agent_browser_web_search calls/);
								assert.match(section, /HTTP 429/);
							} else {
								assert.doesNotMatch(section, /Prefer agent_browser_web_search for current or external web facts/);
							}
							assert.doesNotMatch(effective, /pipeline-unused-search-key/);
							for (const docsPath of [resolve("README.md"), resolve("docs/COMMAND_REFERENCE.md"), resolve("docs/TOOL_CONTRACT.md")]) {
								assert.ok(section.includes(docsPath), `missing installed docs path: ${docsPath}`);
								assert.ok(existsSync(docsPath));
							}
							assert.ok(effective.includes(`Companion instruction for: ${prompt}`));
							assert.deepEqual(request.messages[0], requests[0].messages[0], "later turns must preserve the original system-message prefix");
							assert.equal(getCurrentSystemPrompt(session.messages), effective, "provider and session transcript must agree");
						}
						await session.prompt("Open the page with my custom prompt.");
						assert.equal(observedForcing.at(-1), forcedPrompt);
						const forcedRequest = requests.at(-1);
						assert.ok(forcedRequest);
						assert.equal(getCurrentSystemPrompt(forcedRequest.messages), forcedPrompt, "explicit caller forcing must still reach the provider exactly");
						assert.ok(getCurrentSystemMessage(session.messages)?.sections?.agent_browser, "forcing must not erase structured browser history");
					} finally {
						session.dispose();
					}
				});
			} finally {
				process.argv = originalArgv;
				await rm(root, { recursive: true, force: true });
			}
		});
	}
});

test("Pi pipeline patches persisted QA reclassification failures to isError with model-visible prose", async () => {
	const pipeline = await runPipelinePrompt({
		toolArguments: { qa: { expectedSelector: "main", expectedText: ["Welcome"], url: "https://fail.example.test/" } },
		fakeScript: `const fs = require("node:fs");
const stdin = fs.readFileSync(0, "utf8");
const steps = JSON.parse(stdin || "[]");
const results = steps.map((step) => {
  const name = step[0];
  if (name === "open") return { command: step, success: true, result: { title: "Failure page", url: step[1] } };
  if (name === "network" && step.includes("--clear")) return { command: step, success: true, result: { requests: [] } };
  if (name === "network") return { command: step, success: true, result: { requests: [{ method: "GET", resourceType: "fetch", status: 500, url: "https://fail.example.test/api" }] } };
  if (name === "console" && step.includes("--clear")) return { command: step, success: true, result: { messages: [] } };
  if (name === "console") return { command: step, success: true, result: { messages: [{ type: "error", text: "boom" }] } };
  if (name === "errors" && step.includes("--clear")) return { command: step, success: true, result: { errors: [] } };
  if (name === "errors") return { command: step, success: true, result: { errors: [{ text: "page boom" }] } };
  return { command: step, success: true, result: { ok: true } };
});
process.stdout.write(JSON.stringify(results));`,
	});

	for (const result of [pipeline.inMemoryResult, pipeline.persistedResult]) {
		assert.equal(result.isError, true);
		assert.equal((result.details as { failureCategory?: string; resultCategory?: string } | undefined)?.resultCategory, "failure");
		assert.equal((result.details as { failureCategory?: string } | undefined)?.failureCategory, "qa-failure");
		const text = result.content.find((item) => item.type === "text")?.text ?? "";
		assert.match(text, /Result category: failure; failureCategory: qa-failure; Pi tool isError: true\./);
	}
	assert.match(pipeline.sessionFile, /\.jsonl$/);
});

test("Pi pipeline rejects unsupported public schema fields before spawning upstream", async () => {
	const pipeline = await runPipelinePrompt({
		toolArguments: { args: ["get", "url"], unsupportedRootField: true },
		fakeScript: `process.stdout.write(JSON.stringify({ success: true, data: "unexpected" }));`,
	});

	for (const result of [pipeline.inMemoryResult, pipeline.persistedResult]) {
		assert.equal(result.isError, true);
		const text = result.content.find((item) => item.type === "text")?.text ?? "";
		assert.match(text, /unsupportedRootField|additional/i);
	}
	assert.deepEqual(pipeline.invocations, []);
});

test("Pi pipeline preserves persisted parseable JSON content while patching isError", async () => {
	const pipeline = await runPipelinePrompt({
		toolArguments: { args: ["--json", "get", "url"] },
		fakeScript: `process.stdout.write(JSON.stringify({ success: false, error: "json boom", data: { code: "boom" } }));`,
	});

	for (const result of [pipeline.inMemoryResult, pipeline.persistedResult]) {
		assert.equal(result.isError, true);
		assert.equal((result.details as { resultCategory?: string } | undefined)?.resultCategory, "failure");
		const text = result.content.find((item) => item.type === "text")?.text ?? "";
		assert.doesNotMatch(text, /Pi tool isError/);
		assert.deepEqual(JSON.parse(text), { error: "json boom", success: false });
	}
});
