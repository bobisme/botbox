#!/usr/bin/env node
import { spawn } from 'child_process';

/**
 * Detect output format: explicit flag > FORMAT env > TTY auto-detect
 * @param {string} [explicit] - Explicit format from --format flag
 * @returns {"pretty" | "text"}
 */
function detectFormat(explicit) {
	if (explicit === 'pretty' || explicit === 'text') return explicit;
	let env = process.env['FORMAT'];
	if (env === 'pretty' || env === 'text') return env;
	return process.stdout.isTTY ? 'pretty' : 'text';
}

/**
 * Run an agent with real-time output
 * @param {string} agentType - The type of agent to run (e.g., 'claude')
 * @param {object} options - Command options
 */
export async function runAgent(agentType, options) {
	if (agentType !== 'claude') {
		throw new Error(`Unsupported agent type: ${agentType}. Currently only 'claude' is supported.`);
	}

	let { prompt, model, timeout = 600, format: formatFlag } = options;
	let format = detectFormat(formatFlag);
	let style = format === 'pretty' ? prettyStyle : textStyle;

	if (!prompt) {
		throw new Error('Prompt is required. Use --prompt or -p flag.');
	}

	let args = [
		'--dangerously-skip-permissions',
		'--allow-dangerously-skip-permissions',
		'--verbose',
		'--output-format',
		'stream-json',
	];

	if (model) {
		args.push('--model', model);
	}

	args.push('-p', prompt);

	return new Promise((resolve, reject) => {
		let proc = spawn('claude', args);
		proc.stdin?.end();

		let output = '';
		let resultReceived = false;
		let timeoutKiller = null;
		let overallTimeout = null;

		proc.stdout?.on('data', (data) => {
			let lines = data.toString().split('\n');
			for (let line of lines) {
				if (!line.trim()) continue;
				output += line + '\n';

				try {
					let parsed = JSON.parse(line);
					printEvent(parsed, style);

					if (parsed.type === 'result') {
						resultReceived = true;
						timeoutKiller = setTimeout(() => {
							console.error('Warning: Process hung after completion, killing...');
							proc.kill('SIGKILL');
						}, 2000);
					}
				} catch {
					// Not valid JSON, skip
				}
			}
		});

		let detectedError = null;

		proc.stderr?.on('data', (data) => {
			let stderr = data.toString();
			detectedError = detectApiError(stderr);
			if (detectedError) {
				console.error(`\n${style.yellow}FATAL:${style.reset} ${detectedError}`);
			} else if (stderr.includes('Error') || stderr.includes('error')) {
				console.error(stderr);
			}
		});

		proc.on('close', (code) => {
			if (timeoutKiller) clearTimeout(timeoutKiller);
			if (overallTimeout) clearTimeout(overallTimeout);

			if (resultReceived) {
				resolve({ output, code: 0 });
			} else if (code === 0) {
				resolve({ output, code });
			} else {
				let errorMsg = detectedError
					? `${detectedError} (exit code ${code})`
					: `Agent exited with code ${code}`;
				reject(new Error(errorMsg));
			}
		});

		proc.on('error', (err) => {
			if (timeoutKiller) clearTimeout(timeoutKiller);
			if (overallTimeout) clearTimeout(overallTimeout);
			reject(err);
		});

		overallTimeout = setTimeout(() => {
			if (!resultReceived) {
				console.error(`Timeout after ${timeout}s`);
				proc.kill('SIGKILL');
				reject(new Error(`Timeout after ${timeout}s`));
			}
		}, timeout * 1000);
	});
}

/**
 * Detect fatal API errors from stderr output
 * @param {string} stderr - stderr text
 * @returns {string | null} Error message if detected, null otherwise
 */
function detectApiError(stderr) {
	if (stderr.includes('API Error: 5') || stderr.includes('500')) {
		return 'API Error: Server error (5xx)';
	}
	if (stderr.includes('rate limit') || stderr.includes('Rate limit') || stderr.includes('429')) {
		return 'API Error: Rate limit exceeded';
	}
	if (stderr.includes('overloaded') || stderr.includes('503')) {
		return 'API Error: Service overloaded';
	}
	return null;
}

// --- Style objects ---

/**
 * @typedef {object} OutputStyle
 * @property {string} bold
 * @property {string} dim
 * @property {string} reset
 * @property {string} green
 * @property {string} cyan
 * @property {string} yellow
 * @property {string} bullet
 * @property {string} toolArrow
 * @property {string} checkmark
 * @property {(text: string) => string} formatMarkdown
 */

/** @type {OutputStyle} Pretty mode: ANSI colors + Unicode glyphs */
const prettyStyle = {
	bold: '\x1b[1m',
	dim: '\x1b[2m',
	reset: '\x1b[0m',
	green: '\x1b[32m',
	cyan: '\x1b[36m',
	yellow: '\x1b[33m',
	bullet: '\u2022',
	toolArrow: '\u25b6',
	checkmark: '\u2713',
	formatMarkdown: formatMarkdownPretty,
};

/** @type {OutputStyle} Text mode: no color, ASCII-only glyphs */
const textStyle = {
	bold: '',
	dim: '',
	reset: '',
	green: '',
	cyan: '',
	yellow: '',
	bullet: '-',
	toolArrow: '>',
	checkmark: '+',
	formatMarkdown: formatMarkdownText,
};

/**
 * Format markdown text with ANSI colors (pretty mode)
 * @param {string} text - Markdown text to format
 * @returns {string} ANSI-formatted text
 */
function formatMarkdownPretty(text) {
	let s = prettyStyle;
	text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (_m, _l, code) =>
		`\n${s.dim}${code.trim()}${s.reset}\n`);
	text = text.replace(/`([^`]+)`/g, `${s.cyan}$1${s.reset}`);
	text = text.replace(/\*\*([^*]+)\*\*/g, `${s.bold}$1${s.reset}`);
	text = text.replace(/^(#{1,3})\s+(.+)$/gm, (_m, _h, title) =>
		`${s.bold}${s.yellow}${title}${s.reset}`);
	return text;
}

/**
 * Format markdown text as plain ASCII (text mode).
 * Strips markdown syntax, preserves readable content.
 * @param {string} text - Markdown text to format
 * @returns {string} Plain text
 */
function formatMarkdownText(text) {
	text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (_m, _l, code) =>
		`\n${code.trim()}\n`);
	text = text.replace(/`([^`]+)`/g, '$1');
	text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
	text = text.replace(/^(#{1,3})\s+(.+)$/gm, '$2');
	return text;
}

/**
 * Print a text/thinking event
 * @param {object} event
 * @param {OutputStyle} style
 */
function printTextEvent(event, style) {
	if (!event.text) return;
	let firstLine = event.text.split('\n')[0].slice(0, 120);
	if (!firstLine.trim()) return;
	let text = event.text.length > 120 ? firstLine + '...' : firstLine;
	console.log(`${style.dim}${style.bullet} ${text}${style.reset}`);
}

/**
 * Print an assistant event (text response or tool use)
 * @param {object} event
 * @param {OutputStyle} style
 */
function printAssistantEvent(event, style) {
	if (!event.message?.content) return;
	for (let item of event.message.content) {
		if (item.type === 'text' && item.text) {
			let formatted = style.formatMarkdown(item.text);
			console.log(`\n${formatted}`);
		} else if (item.type === 'tool_use') {
			let toolName = item.name;
			let truncatedInput = JSON.stringify(item.input || {}).slice(0, 80);
			let inputStr = truncatedInput.length >= 80 ? truncatedInput + '...' : truncatedInput;
			console.log(`\n${style.toolArrow} ${style.bold}${toolName}${style.reset} ${style.dim}${inputStr}${style.reset}`);
		}
	}
}

/**
 * Print a user event (tool results)
 * @param {object} event
 * @param {OutputStyle} style
 */
function printUserEvent(event, style) {
	if (!event.message?.content) return;
	for (let item of event.message.content) {
		if (item.type !== 'tool_result') continue;
		let content = item.content || '';
		let contentStr = typeof content === 'string' ? content : JSON.stringify(content);
		let truncated = contentStr.slice(0, 100).replace(/\n/g, ' ');
		let resultText = contentStr.length > 100 ? truncated + '...' : truncated;
		console.log(`  ${style.green}${style.checkmark}${style.reset} ${style.dim}${resultText}${style.reset}`);
	}
}

/**
 * Print a JSON stream event using the given style
 * @param {object} event - Parsed JSON event
 * @param {OutputStyle} style - Output style (pretty or text)
 */
function printEvent(event, style) {
	switch (event.type) {
		case 'text':
			printTextEvent(event, style);
			break;
		case 'assistant':
			printAssistantEvent(event, style);
			break;
		case 'user':
			printUserEvent(event, style);
			break;
		case 'result':
			break;
		default:
			break;
	}
}
