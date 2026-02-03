#!/usr/bin/env node
import { spawn } from 'child_process';

/**
 * Run an agent with pretty real-time output
 * @param {string} agentType - The type of agent to run (e.g., 'claude')
 * @param {object} options - Command options
 */
export async function runAgent(agentType, options) {
	if (agentType !== 'claude') {
		throw new Error(`Unsupported agent type: ${agentType}. Currently only 'claude' is supported.`);
	}

	const { prompt, model, timeout = 600 } = options;

	if (!prompt) {
		throw new Error('Prompt is required. Use --prompt or -p flag.');
	}

	const args = [
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
		const proc = spawn('claude', args);
		proc.stdin?.end(); // Close stdin immediately

		let output = '';
		let resultReceived = false;
		let timeoutKiller = null;

		console.log(); // Blank line before output

		// Parse JSON stream line-by-line
		proc.stdout?.on('data', (data) => {
			const lines = data.toString().split('\n');
			for (const line of lines) {
				if (!line.trim()) continue;
				output += line + '\n';

				try {
					const parsed = JSON.parse(line);
					prettyPrint(parsed);

					// Detect completion signal
					if (parsed.type === 'result') {
						resultReceived = true;
						console.log(`\n${GREEN}✓${RESET} Agent completed\n`);

						// Give 2s grace period, then kill if hung
						timeoutKiller = setTimeout(() => {
							console.log('Warning: Process hung after completion, killing...');
							proc.kill('SIGKILL');
						}, 2000);
					}
				} catch {
					// Not valid JSON, skip
				}
			}
		});

		proc.stderr?.on('data', (data) => {
			// Only show critical errors, not debug output
			const stderr = data.toString();
			if (stderr.includes('Error') || stderr.includes('error')) {
				console.error(stderr);
			}
		});

		proc.on('close', (code) => {
			if (timeoutKiller) clearTimeout(timeoutKiller);

			if (resultReceived) {
				resolve({ output, code: 0 });
			} else if (code === 0) {
				resolve({ output, code });
			} else {
				reject(new Error(`Agent exited with code ${code}`));
			}
		});

		proc.on('error', (err) => {
			if (timeoutKiller) clearTimeout(timeoutKiller);
			reject(err);
		});

		// Overall timeout
		setTimeout(() => {
			if (!resultReceived) {
				console.error(`Timeout after ${timeout}s`);
				proc.kill('SIGKILL');
				reject(new Error(`Timeout after ${timeout}s`));
			}
		}, timeout * 1000);
	});
}

// --- ANSI formatting ---
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';

/**
 * Format markdown text with ANSI colors
 * @param {string} text - Markdown text to format
 * @returns {string} ANSI-formatted text
 */
function formatMarkdown(text) {
	// Code blocks (```...```)
	text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
		return `\n${DIM}${code.trim()}${RESET}\n`;
	});

	// Inline code (`...`)
	text = text.replace(/`([^`]+)`/g, `${CYAN}$1${RESET}`);

	// Bold (**...**)
	text = text.replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${RESET}`);

	// Headers (### ...)
	text = text.replace(/^(#{1,3})\s+(.+)$/gm, (match, hashes, title) => {
		return `${BOLD}${YELLOW}${title}${RESET}`;
	});

	return text;
}

/**
 * Pretty print JSON stream events
 * @param {object} event - Parsed JSON event
 */
function prettyPrint(event) {
	switch (event.type) {
		case 'text':
			// Thinking or response text - show first line only
			if (event.text) {
				const firstLine = event.text.split('\n')[0].slice(0, 120);
				if (firstLine.trim()) {
					const text = event.text.length > 120 ? firstLine + '...' : firstLine;
					console.log(`${DIM}• ${text}${RESET}`);
				}
			}
			break;

		case 'assistant':
			// Assistant messages can contain text, tool_use, or both
			if (event.message?.content) {
				for (const item of event.message.content) {
					if (item.type === 'text' && item.text) {
						const formatted = formatMarkdown(item.text);
						console.log(`\n${formatted}`);
					} else if (item.type === 'tool_use') {
						const toolName = item.name;
						const truncatedInput = JSON.stringify(item.input || {}).slice(0, 80);
						const args = truncatedInput.length >= 80 ? truncatedInput + '...' : truncatedInput;
						console.log(`▶ ${BOLD}${toolName}${RESET} ${DIM}${args}${RESET}`);
					}
				}
			}
			break;

		case 'user':
			// User messages contain tool results
			if (event.message?.content) {
				for (const item of event.message.content) {
					if (item.type === 'tool_result') {
						const content = item.content || '';
						const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
						const truncated = contentStr.slice(0, 100).replace(/\n/g, ' ');
						const resultText = contentStr.length > 100 ? truncated + '...' : truncated;
						console.log(`  ${GREEN}✓${RESET} ${DIM}${resultText}${RESET}`);
					}
				}
			}
			break;

		case 'result':
			// Handled separately in main loop
			break;

		default:
			// Unknown event type, skip (system events, etc.)
			break;
	}
}
