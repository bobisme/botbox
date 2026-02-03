#!/usr/bin/env node
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { parseArgs } from 'util';

// --- Defaults ---
let MAX_LOOPS = 20;
let LOOP_PAUSE = 2;
let CLAUDE_TIMEOUT = 600;
let MODEL = '';
let PROJECT = '';
let AGENT = '';

// --- Load config from .botbox.json ---
async function loadConfig() {
	if (existsSync('.botbox.json')) {
		try {
			const config = JSON.parse(await readFile('.botbox.json', 'utf-8'));
			MODEL = config.agents?.reviewer?.model || '';
			MAX_LOOPS = config.agents?.reviewer?.max_loops || 20;
			LOOP_PAUSE = config.agents?.reviewer?.pause || 2;
			CLAUDE_TIMEOUT = config.agents?.reviewer?.timeout || 600;
		} catch (err) {
			console.error('Warning: Failed to load .botbox.json:', err.message);
		}
	}
}

// --- Parse CLI args ---
function parseCliArgs() {
	const { values, positionals } = parseArgs({
		options: {
			'max-loops': { type: 'string' },
			pause: { type: 'string' },
			model: { type: 'string' },
			help: { type: 'boolean', short: 'h' },
		},
		allowPositionals: true,
	});

	if (values.help) {
		console.log(`Usage: reviewer-loop.mjs [options] <project> <agent-name>

Reviewer agent. Picks one open review per iteration, reads the diff,
leaves comments, and votes LGTM or BLOCKED.

Options:
  --max-loops N   Max iterations (default: ${MAX_LOOPS})
  --pause N       Seconds between iterations (default: ${LOOP_PAUSE})
  --model M       Model for the reviewer agent (default: ${MODEL || 'opus'})
  -h, --help      Show this help

Arguments:
  project         Project name (required)
  agent-name      Agent identity (required)`);
		process.exit(0);
	}

	if (values['max-loops']) MAX_LOOPS = parseInt(values['max-loops'], 10);
	if (values.pause) LOOP_PAUSE = parseInt(values.pause, 10);
	if (values.model) MODEL = values.model;

	if (positionals.length < 2) {
		console.error('Error: Project name and agent name required');
		console.error('Usage: reviewer-loop.mjs [options] <project> <agent-name>');
		process.exit(1);
	}

	PROJECT = positionals[0];
	AGENT = positionals[1];
}

// --- Helper: run command and get output ---
async function runCommand(cmd, args = []) {
	return new Promise((resolve, reject) => {
		const proc = spawn(cmd, args);
		let stdout = '';
		let stderr = '';

		proc.stdout?.on('data', (data) => (stdout += data));
		proc.stderr?.on('data', (data) => (stderr += data));

		proc.on('close', (code) => {
			if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
			else reject(new Error(`${cmd} exited with code ${code}: ${stderr}`));
		});
	});
}

// --- Helper: check if there are reviews ---
async function hasWork() {
	try {
		const result = await runCommand('crit', ['reviews', 'list', '--format', 'json']);
		const reviews = JSON.parse(result.stdout || '[]');
		const openReviews = Array.isArray(reviews)
			? reviews.filter((r) => r.status === 'open')
			: [];
		return openReviews.length > 0;
	} catch (err) {
		console.error('Error checking for reviews:', err.message);
		return false;
	}
}

// --- Build reviewer prompt ---
function buildPrompt() {
	return `You are reviewer agent "${AGENT}" for project "${PROJECT}".

IMPORTANT: Use --agent ${AGENT} on ALL bus and crit commands. Set BOTBOX_PROJECT=${PROJECT}.

Execute exactly ONE review cycle, then STOP. Do not process multiple reviews.

At the end of your work, output exactly one of these completion signals:
- <promise>COMPLETE</promise> if you completed a review or determined no reviews exist
- <promise>BLOCKED</promise> if you encountered an error

1. INBOX:
   Run: bus inbox --agent ${AGENT} --channels ${PROJECT} --mark-read
   Note any review-request or review-response messages. Ignore task-claim, task-done, spawn-ack, etc.

2. FIND REVIEWS:
   Run: crit reviews list --format json
   Look for open reviews (status: "open"). Pick one to process.
   If no open reviews exist, say "NO_REVIEWS_PENDING" and stop.
   bus statuses set --agent ${AGENT} "Review: <review-id>" --ttl 30m

3. REVIEW (follow .agents/botbox/review-loop.md):
   a. Read the review and diff: crit review <id> and crit diff <id>
   b. Read the full source files changed in the diff — use absolute paths
   c. Check project config (e.g., Cargo.toml, package.json) for dependencies and settings
   d. Run static analysis if applicable (e.g., cargo clippy, oxlint) — cite warnings in comments
   e. Cross-file consistency: compare similar functions across files for uniform security/validation.
      If one function does it right and another doesn't, that's a bug.
   f. Boundary checks: trace user-supplied values through to where they're used.
      Check arithmetic for edge cases: 0, 1, MAX, negative, empty.
   g. For each issue found, comment with severity:
      - CRITICAL: Security vulnerabilities, data loss, crashes in production
      - HIGH: Correctness bugs, race conditions, resource leaks
      - MEDIUM: Error handling gaps, missing validation at boundaries
      - LOW: Code quality, naming, structure
      - INFO: Suggestions, style preferences, minor improvements
      Use: crit comment <id> "SEVERITY: <feedback>" --file <path> --line <line-or-range>
   h. Vote:
      - crit block <id> --reason "..." if any CRITICAL or HIGH issues exist
      - crit lgtm <id> if no CRITICAL or HIGH issues

4. ANNOUNCE:
   bus send --agent ${AGENT} ${PROJECT} "Review complete: <review-id> — <LGTM|BLOCKED>" -L review-done

5. RE-REVIEW (if a review-response message indicates the author addressed feedback):
   The author's fixes are in their workspace, not the main branch.
   Check the review-response bus message for the workspace path.
   Read files from the workspace path (e.g., .workspaces/\$WS/src/...).
   Verify fixes against original issues — read actual code, don't just trust replies.
   Run static analysis in the workspace: cd <workspace-path> && <analysis-command>
   If all resolved: crit lgtm <id>. If not: reply on threads explaining what's still wrong.

Key rules:
- Process exactly one review per cycle, then STOP.
- Focus on security and correctness. Ground findings in evidence — compiler output,
  documentation, or source code — not assumptions about API behavior.
- All bus and crit commands use --agent ${AGENT}.
- STOP after completing one review. Do not loop.
- Always output <promise>COMPLETE</promise> or <promise>BLOCKED</promise> at the end.`;
}

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
async function runClaude(prompt) {
	return new Promise((resolve, reject) => {
		const args = [
			'--dangerously-skip-permissions',
			'--allow-dangerously-skip-permissions',
			'--output-format',
			'stream-json',
		];
		if (MODEL) args.push('--model', MODEL);
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
						console.log('\n✓ Claude completed');

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
				console.error(`Timeout after ${CLAUDE_TIMEOUT}s`);
				proc.kill('SIGKILL');
				reject(new Error(`Timeout after ${CLAUDE_TIMEOUT}s`));
			}
		}, CLAUDE_TIMEOUT * 1000);
	});
}

// --- Cleanup handler ---
async function cleanup() {
	console.log('Cleaning up...');
	try {
		await runCommand('bus', ['statuses', 'clear', '--agent', AGENT]);
	} catch {}
	try {
		await runCommand('bus', ['claims', 'release', '--agent', AGENT, `agent://${AGENT}`]);
	} catch {}
	console.log(`Cleanup complete for ${AGENT}.`);
}

process.on('SIGINT', async () => {
	await cleanup();
	process.exit(0);
});

process.on('SIGTERM', async () => {
	await cleanup();
	process.exit(0);
});

// --- Main ---
async function main() {
	await loadConfig();
	parseCliArgs();

	console.log(`Reviewer:  ${AGENT}`);
	console.log(`Project:   ${PROJECT}`);
	console.log(`Max loops: ${MAX_LOOPS}`);
	console.log(`Pause:     ${LOOP_PAUSE}s`);
	console.log(`Model:     ${MODEL || 'opus'}`);

	// Confirm identity
	try {
		await runCommand('bus', ['whoami', '--agent', AGENT]);
	} catch (err) {
		console.error('Error confirming agent identity:', err.message);
		process.exit(1);
	}

	// Try to refresh claim, otherwise stake
	try {
		await runCommand('bus', ['claims', 'refresh', '--agent', AGENT, `agent://${AGENT}`]);
	} catch {
		try {
			await runCommand('bus', [
				'claims',
				'stake',
				'--agent',
				AGENT,
				`agent://${AGENT}`,
				'-m',
				`reviewer-loop for ${PROJECT}`,
			]);
		} catch (err) {
			console.log(`Claim denied. Agent ${AGENT} is already running.`);
			process.exit(0);
		}
	}

	// Announce
	await runCommand('bus', [
		'send',
		'--agent',
		AGENT,
		PROJECT,
		`Reviewer ${AGENT} online, starting review loop`,
		'-L',
		'spawn-ack',
	]);

	// Set starting status
	await runCommand('bus', ['statuses', 'set', '--agent', AGENT, 'Starting loop', '--ttl', '10m']);

	// Main loop
	for (let i = 1; i <= MAX_LOOPS; i++) {
		console.log(`\n--- Review loop ${i}/${MAX_LOOPS} ---`);

		if (!(await hasWork())) {
			await runCommand('bus', ['statuses', 'set', '--agent', AGENT, 'Idle']);
			console.log('No reviews pending. Exiting cleanly.');
			await runCommand('bus', [
				'send',
				'--agent',
				AGENT,
				PROJECT,
				`No reviews pending. Reviewer ${AGENT} signing off.`,
				'-L',
				'agent-idle',
			]);
			break;
		}

		// Run Claude
		try {
			const prompt = buildPrompt();
			const result = await runClaude(prompt);

			// Check for completion signals
			if (result.output.includes('<promise>COMPLETE</promise>')) {
				console.log('✓ Review cycle complete');
			} else if (result.output.includes('<promise>BLOCKED</promise>')) {
				console.log('⚠ Reviewer blocked');
			} else {
				console.log('Warning: No completion signal found in output');
			}
		} catch (err) {
			console.error('Error running Claude:', err.message);
			// Continue to next iteration on error
		}

		if (i < MAX_LOOPS) {
			await new Promise((resolve) => setTimeout(resolve, LOOP_PAUSE * 1000));
		}
	}

	await cleanup();
}

main().catch((err) => {
	console.error('Fatal error:', err);
	cleanup().finally(() => process.exit(1));
});
