use std::io::{BufRead, BufReader, IsTerminal};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context};
use serde_json::Value;

use crate::error::ExitError;

/// Output format: pretty (ANSI colors) or text (plain)
#[derive(Debug, Clone, Copy, PartialEq)]
enum OutputFormat {
    Pretty,
    Text,
}

impl OutputFormat {
    fn detect(explicit: Option<&str>) -> Self {
        if let Some(fmt) = explicit {
            return match fmt {
                "pretty" => OutputFormat::Pretty,
                "text" => OutputFormat::Text,
                _ => OutputFormat::Text,
            };
        }

        if let Ok(env) = std::env::var("FORMAT") {
            if env == "pretty" {
                return OutputFormat::Pretty;
            } else if env == "text" {
                return OutputFormat::Text;
            }
        }

        // TTY detection: check stdout.is_terminal() OR presence of TERM env var
        // The TERM check handles cases where we're in a PTY (like botty spawn)
        // but stdout appears as a pipe due to stream processing
        if std::io::stdout().is_terminal() {
            OutputFormat::Pretty
        } else if let Ok(term) = std::env::var("TERM") {
            // If TERM is set and not "dumb", treat as a terminal
            if !term.is_empty() && term != "dumb" {
                OutputFormat::Pretty
            } else {
                OutputFormat::Text
            }
        } else {
            OutputFormat::Text
        }
    }
}

/// ANSI codes for pretty output
struct Style {
    bold: &'static str,
    bright: &'static str,
    bold_bright: &'static str,
    dim: &'static str,
    reset: &'static str,
    green: &'static str,
    cyan: &'static str,
    yellow: &'static str,
    bullet: &'static str,
    tool_arrow: &'static str,
    checkmark: &'static str,
}

const PRETTY_STYLE: Style = Style {
    bold: "\x1b[1m",
    bright: "\x1b[97m",
    bold_bright: "\x1b[1;97m",
    dim: "\x1b[2m",
    reset: "\x1b[0m",
    green: "\x1b[32m",
    cyan: "\x1b[36m",
    yellow: "\x1b[33m",
    bullet: "\u{2022}",
    tool_arrow: "\u{25b6}",
    checkmark: "\u{2713}",
};

const TEXT_STYLE: Style = Style {
    bold: "",
    bright: "",
    bold_bright: "",
    dim: "",
    reset: "",
    green: "",
    cyan: "",
    yellow: "",
    bullet: "-",
    tool_arrow: ">",
    checkmark: "+",
};

/// Run the Claude Code agent with stream-JSON parsing
pub fn run_agent(
    agent_type: &str,
    prompt: &str,
    model: Option<&str>,
    timeout_secs: u64,
    format: Option<&str>,
    skip_permissions: bool,
) -> anyhow::Result<()> {
    if agent_type != "claude" {
        return Err(anyhow!(
            "Unsupported agent type: {}. Currently only 'claude' is supported.",
            agent_type
        ));
    }

    let format = OutputFormat::detect(format);
    let style = match format {
        OutputFormat::Pretty => &PRETTY_STYLE,
        OutputFormat::Text => &TEXT_STYLE,
    };

    // Build command args
    let mut args = vec![
        "--verbose",
        "--output-format",
        "stream-json",
    ];

    // Only add permission bypass when explicitly requested by the caller
    if skip_permissions {
        args.push("--dangerously-skip-permissions");
        args.push("--allow-dangerously-skip-permissions");
    }

    let model_arg;
    if let Some(m) = model {
        model_arg = m.to_string();
        args.push("--model");
        args.push(&model_arg);
    }

    args.push("-p");
    args.push(prompt);

    // Spawn process
    let mut child = Command::new("claude")
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| -> anyhow::Error {
            if e.kind() == std::io::ErrorKind::NotFound {
                ExitError::ToolNotFound {
                    tool: "claude".to_string(),
                }
                .into()
            } else {
                anyhow::Error::new(e).context("spawning claude")
            }
        })?;

    // Spawn threads to read stdout and stderr
    let stdout = child.stdout.take().context("failed to capture stdout")?;
    let stderr = child.stderr.take().context("failed to capture stderr")?;

    let (stdout_tx, stdout_rx) = channel();
    let (stderr_tx, stderr_rx) = channel();

    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
            let _ = stdout_tx.send(line);
        }
    });

    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            let _ = stderr_tx.send(line);
        }
    });

    // Process output
    let result = process_output(
        &mut child,
        stdout_rx,
        stderr_rx,
        style,
        Duration::from_secs(timeout_secs),
    );

    // Clean up
    let _ = child.kill();
    let _ = child.wait();

    result
}

fn process_output(
    child: &mut Child,
    stdout_rx: Receiver<String>,
    stderr_rx: Receiver<String>,
    style: &Style,
    timeout: Duration,
) -> anyhow::Result<()> {
    let start = Instant::now();
    let mut result_received = false;
    let mut result_time: Option<Instant> = None;
    let mut detected_error: Option<String> = None;

    loop {
        // Check timeout
        let elapsed = start.elapsed();
        if elapsed >= timeout && !result_received {
            return Err(ExitError::Timeout {
                tool: "claude".to_string(),
                timeout_secs: timeout.as_secs(),
            }
            .into());
        }

        // Check if we should kill after result
        if let Some(result_instant) = result_time
            && result_instant.elapsed() >= Duration::from_secs(2) {
                // Kill hung process
                eprintln!("Warning: Process hung after completion, killing...");
                return Ok(());
            }

        // Check if process exited
        match child.try_wait() {
            Ok(Some(status)) => {
                // Process exited
                if result_received {
                    return Ok(());
                } else if status.success() {
                    return Ok(());
                } else {
                    let code = status.code().unwrap_or(-1);
                    let error_msg = if let Some(err) = detected_error {
                        format!("{} (exit code {})", err, code)
                    } else {
                        format!("Agent exited with code {}", code)
                    };
                    return Err(ExitError::ToolFailed {
                        tool: "claude".to_string(),
                        code,
                        message: error_msg,
                    }
                    .into());
                }
            }
            Ok(None) => {
                // Still running
            }
            Err(e) => {
                return Err(anyhow::Error::new(e).context("waiting for claude"));
            }
        }

        // Process stdout
        while let Ok(line) = stdout_rx.try_recv() {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(event) = serde_json::from_str::<Value>(&line) {
                print_event(&event, style);
                if event.get("type").and_then(|t| t.as_str()) == Some("result") {
                    result_received = true;
                    result_time = Some(Instant::now());
                }
            }
        }

        // Process stderr
        while let Ok(line) = stderr_rx.try_recv() {
            if let Some(err) = detect_api_error(&line) {
                detected_error = Some(err.clone());
                eprintln!("\n{}FATAL:{} {}", style.yellow, style.reset, err);
            } else if line.contains("Error") || line.contains("error") {
                eprintln!("{}", line);
            }
        }

        // Small sleep to avoid busy loop
        thread::sleep(Duration::from_millis(10));
    }
}

/// Truncate a string at a valid UTF-8 char boundary.
fn truncate_safe(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn detect_api_error(stderr: &str) -> Option<String> {
    if stderr.contains("API Error: 5") || stderr.contains("500") {
        Some("API Error: Server error (5xx)".to_string())
    } else if stderr.contains("rate limit")
        || stderr.contains("Rate limit")
        || stderr.contains("429")
    {
        Some("API Error: Rate limit exceeded".to_string())
    } else if stderr.contains("overloaded") || stderr.contains("503") {
        Some("API Error: Service overloaded".to_string())
    } else {
        None
    }
}

fn print_event(event: &Value, style: &Style) {
    match event.get("type").and_then(|t| t.as_str()) {
        Some("text") => print_text_event(event, style),
        Some("assistant") => print_assistant_event(event, style),
        Some("user") => print_user_event(event, style),
        Some("result") => {} // Silent
        _ => {}
    }
}

fn print_text_event(event: &Value, style: &Style) {
    if let Some(text) = event.get("text").and_then(|t| t.as_str()) {
        if text.trim().is_empty() {
            return;
        }
        let first_line = text.lines().next().unwrap_or("");
        let truncated = if first_line.len() > 120 {
            format!("{}...", truncate_safe(first_line, 120))
        } else {
            first_line.to_string()
        };
        if !truncated.trim().is_empty() {
            println!("{}{} {}{}", style.bright, style.bullet, truncated, style.reset);
        }
    }
}

fn print_assistant_event(event: &Value, style: &Style) {
    if let Some(content) = event
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    {
        for item in content {
            if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    let formatted = format_markdown(text, style);
                    println!("\n{}{}{}", style.bright, formatted, style.reset);
                }
            } else if item.get("type").and_then(|t| t.as_str()) == Some("tool_use")
                && let Some(tool_name) = item.get("name").and_then(|n| n.as_str()) {
                    let input = item.get("input").unwrap_or(&Value::Null);
                    let input_str = serde_json::to_string(input).unwrap_or_default();
                    let truncated = if input_str.len() > 80 {
                        format!("{}...", truncate_safe(&input_str, 80))
                    } else {
                        input_str
                    };
                    println!(
                        "\n{} {}{}{} {}{}{}",
                        style.tool_arrow,
                        style.bold_bright,
                        tool_name,
                        style.reset,
                        style.dim,
                        truncated,
                        style.reset
                    );
                }
        }
    }
}

fn print_user_event(event: &Value, style: &Style) {
    if let Some(content) = event
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    {
        for item in content {
            if item.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                let content_val = item.get("content");
                let content_str = match content_val {
                    Some(Value::String(s)) => s.clone(),
                    Some(other) => serde_json::to_string(other).unwrap_or_default(),
                    None => String::new(),
                };
                let truncated = content_str.replace('\n', " ");
                let truncated = if truncated.len() > 100 {
                    format!("{}...", truncate_safe(&truncated, 100))
                } else {
                    truncated
                };
                println!(
                    "  {}{}{} {}{}{}",
                    style.green, style.checkmark, style.reset, style.dim, truncated, style.reset
                );
            }
        }
    }
}

fn re_code_block() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"```(\w+)?\n([\s\S]*?)```").unwrap())
}

fn re_inline_code() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"`([^`]+)`").unwrap())
}

fn re_bold() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"\*\*([^*]+)\*\*").unwrap())
}

fn re_headers() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?m)^#{1,3}\s+(.+)$").unwrap())
}

fn format_markdown(text: &str, style: &Style) -> String {
    if style.bold.is_empty() {
        // Text mode: strip markdown
        let mut result = text.to_string();
        result = re_code_block()
            .replace_all(&result, |caps: &regex::Captures| {
                format!("\n{}\n", caps.get(2).map_or("", |m| m.as_str()).trim())
            })
            .to_string();
        result = re_inline_code().replace_all(&result, "$1").to_string();
        result = re_bold().replace_all(&result, "$1").to_string();
        result = re_headers().replace_all(&result, "$1").to_string();
        result
    } else {
        // Pretty mode: ANSI colors
        let mut result = text.to_string();
        result = re_code_block()
            .replace_all(&result, |caps: &regex::Captures| {
                format!(
                    "\n{}{}\n{}",
                    style.dim,
                    caps.get(2).map_or("", |m| m.as_str()).trim(),
                    style.reset
                )
            })
            .to_string();
        result = re_inline_code()
            .replace_all(&result, &format!("{}$1{}", style.cyan, style.reset))
            .to_string();
        result = re_bold()
            .replace_all(&result, &format!("{}$1{}", style.bold, style.reset))
            .to_string();
        result = re_headers()
            .replace_all(
                &result,
                &format!("{}{} $1{}", style.bold, style.yellow, style.reset),
            )
            .to_string();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_format_explicit() {
        assert_eq!(OutputFormat::detect(Some("pretty")), OutputFormat::Pretty);
        assert_eq!(OutputFormat::detect(Some("text")), OutputFormat::Text);
    }

    #[test]
    fn detect_format_via_term_env() {
        // Save current TERM value
        let original_term = std::env::var("TERM").ok();

        // Test with TERM=xterm-256color (should enable pretty mode)
        unsafe {
            std::env::set_var("TERM", "xterm-256color");
        }
        // Note: This test might still return Text if stdout is not a TTY,
        // but the TERM check is a fallback that happens after the TTY check fails
        let _format = OutputFormat::detect(None);

        // Test with TERM=dumb (should disable colors)
        unsafe {
            std::env::set_var("TERM", "dumb");
        }
        let format_dumb = OutputFormat::detect(None);
        // dumb terminal should give us Text mode (unless stdout is a real TTY)

        // Test with empty TERM
        unsafe {
            std::env::set_var("TERM", "");
        }
        let format_empty = OutputFormat::detect(None);

        // Restore original TERM
        unsafe {
            match original_term {
                Some(term) => std::env::set_var("TERM", term),
                None => std::env::remove_var("TERM"),
            }
        }

        // Verify dumb and empty both give Text when not in a TTY
        // (can't easily test the Pretty case without a real TTY)
        if !std::io::stdout().is_terminal() {
            assert_eq!(format_dumb, OutputFormat::Text);
            assert_eq!(format_empty, OutputFormat::Text);
        }
    }

    #[test]
    fn detect_api_errors() {
        assert!(detect_api_error("API Error: 500").is_some());
        assert!(detect_api_error("rate limit exceeded").is_some());
        assert!(detect_api_error("service overloaded 503").is_some());
        assert!(detect_api_error("some other error").is_none());
    }

    #[test]
    fn format_markdown_text_mode() {
        let input = "**bold** `code` ```rust\nlet x = 1;\n```\n## Header";
        let output = format_markdown(input, &TEXT_STYLE);
        assert!(!output.contains("**"));
        assert!(!output.contains("`"));
        assert!(!output.contains("```"));
        // Headers on their own line should have the ## removed
        assert!(!output.contains("## Header"));
        assert!(output.contains("Header"));
    }

    #[test]
    fn format_markdown_pretty_mode() {
        let input = "`code`";
        let output = format_markdown(input, &PRETTY_STYLE);
        assert!(output.contains("\x1b[36m")); // cyan
        assert!(output.contains("\x1b[0m")); // reset
    }
}
