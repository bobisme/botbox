#!/usr/bin/env node
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { parseArgs } from 'util';

// --- ANSI formatting ---
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';

// --- Pretty print JSON stream events ---
function prettyPrint(event) {
	switch (event.type) {
		case 'tool_use':
			const toolName = event.name;
			const truncatedInput = JSON.stringify(event.input || {}).slice(0, 80);
			const args = truncatedInput.length >= 80 ? truncatedInput + '...' : truncatedInput;
			// TODO: Custom formatting for known tools (Edit, Read, Write, Bash, etc.)
			console.log(`▶ ${BOLD}${toolName}${RESET} ${DIM}${args}${RESET}`);
			break;

		case 'tool_result':
			const content = event.content || '';
			const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
			const truncated = contentStr.slice(0, 100).replace(/\n/g, ' ');
			const resultText = contentStr.length > 100 ? truncated + '...' : truncated;
			console.log(`  ${GREEN}✓${RESET} ${DIM}${resultText}${RESET}`);
			break;

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

		case 'result':
			// Handled separately
			break;

		default:
			// Unknown event type, skip
			break;
	}
}

// --- Run claude with stream-json and hang workaround ---
function runClaude(prompt, model = null, timeout = 600) {
	return new Promise((resolve, reject) => {
		const args = [
			'--dangerously-skip-permissions',
			'--allow-dangerously-skip-permissions',
			'--output-format',
			'stream-json',
		];
		if (model) args.push('--model', model);
		args.push('-p', prompt);

		const proc = spawn('claude', args);
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

					// Pretty print the event
					prettyPrint(parsed);

					// Detect completion signal
					if (parsed.type === 'result') {
						resultReceived = true;
						console.log(`\n${GREEN}✓${RESET} Claude completed\n`);

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
			console.error(data.toString());
		});

		proc.on('close', (code) => {
			if (timeoutKiller) clearTimeout(timeoutKiller);

			if (resultReceived) {
				resolve({ output, code: 0 });
			} else if (code === 0) {
				resolve({ output, code });
			} else {
				reject(new Error(`Claude exited with code ${code}`));
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

// --- Main ---
async function main() {
	const { values } = parseArgs({
		options: {
			prompt: { type: 'string', short: 'p' },
			model: { type: 'string', short: 'm' },
			timeout: { type: 'string', short: 't' },
			help: { type: 'boolean', short: 'h' },
		},
	});

	if (values.help) {
		console.log(`Usage: claude-pretty.mjs [options]

Run Claude with pretty real-time output showing tool calls and activity.

Options:
  -p, --prompt TEXT   Prompt text (or read from stdin)
  -m, --model NAME    Model to use (default: system default)
  -t, --timeout N     Timeout in seconds (default: 600)
  -h, --help          Show this help

Examples:
  # From stdin
  echo "What is 2+2?" | claude-pretty.mjs

  # With prompt flag
  claude-pretty.mjs -p "List files in current directory" -m haiku

  # From file
  cat prompt.txt | claude-pretty.mjs -m sonnet`);
		process.exit(0);
	}

	// Get prompt from --prompt flag or stdin
	let prompt = values.prompt;
	if (!prompt) {
		if (process.stdin.isTTY) {
			console.error('Error: No prompt provided. Use --prompt or pipe to stdin.');
			console.error('Try: echo "Your prompt" | claude-pretty.mjs');
			process.exit(1);
		}
		// Read from stdin
		prompt = readFileSync(0, 'utf-8');
	}

	const model = values.model || null;
	const timeout = values.timeout ? parseInt(values.timeout, 10) : 600;

	try {
		await runClaude(prompt, model, timeout);
	} catch (err) {
		console.error('Error:', err.message);
		process.exit(1);
	}
}

main();
