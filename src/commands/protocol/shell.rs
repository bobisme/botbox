//! Shell-safe primitives for protocol guidance rendering.
//!
//! Single-quote escaping, identifier validation, and command builder helpers.
//! The renderer layer composes these rather than duplicating quoting logic.

use std::fmt::Write;

/// Escape a string for safe inclusion in a single-quoted shell argument.
///
/// The POSIX approach: wrap in single quotes, and for any embedded single
/// quote, end the current quoting, insert an escaped single quote, and
/// restart quoting: `'` → `'\''`.
///
/// Returns the string with surrounding single quotes.
pub fn shell_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// Validate a bead ID (e.g., `bd-3cqv`).
pub fn validate_bead_id(id: &str) -> Result<(), ValidationError> {
    if id.is_empty() {
        return Err(ValidationError::Empty("bead ID"));
    }
    // bd- prefix followed by alphanumeric
    let valid = id.starts_with("bd-")
        && id.len() > 3
        && id[3..].chars().all(|c| c.is_ascii_alphanumeric());
    if !valid {
        return Err(ValidationError::InvalidFormat {
            field: "bead ID",
            value: id.to_string(),
            expected: "bd-[a-z0-9]+",
        });
    }
    Ok(())
}

/// Validate a workspace name.
pub fn validate_workspace_name(name: &str) -> Result<(), ValidationError> {
    if name.is_empty() {
        return Err(ValidationError::Empty("workspace name"));
    }
    if name.len() > 64 {
        return Err(ValidationError::TooLong {
            field: "workspace name",
            max: 64,
            actual: name.len(),
        });
    }
    let valid = name
        .chars()
        .next()
        .map(|c| c.is_ascii_alphanumeric())
        .unwrap_or(false)
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !valid {
        return Err(ValidationError::InvalidFormat {
            field: "workspace name",
            value: name.to_string(),
            expected: "[a-z0-9][a-z0-9-]*, max 64 chars",
        });
    }
    Ok(())
}

/// Validate an identifier (agent name, project name).
/// Must be non-empty and contain no shell metacharacters.
pub fn validate_identifier(field: &'static str, value: &str) -> Result<(), ValidationError> {
    if value.is_empty() {
        return Err(ValidationError::Empty(field));
    }
    let has_unsafe = value.chars().any(|c| {
        matches!(
            c,
            ' ' | '\t'
                | '\n'
                | '\r'
                | '\''
                | '"'
                | '`'
                | '$'
                | '\\'
                | '!'
                | '&'
                | '|'
                | ';'
                | '('
                | ')'
                | '{'
                | '}'
                | '<'
                | '>'
                | '*'
                | '?'
                | '['
                | ']'
                | '#'
                | '~'
                | '\0'
        )
    });
    if has_unsafe {
        return Err(ValidationError::UnsafeChars {
            field,
            value: value.to_string(),
        });
    }
    Ok(())
}

/// Validation error for shell-rendered values.
#[derive(Debug, Clone)]
pub enum ValidationError {
    Empty(&'static str),
    TooLong {
        field: &'static str,
        max: usize,
        actual: usize,
    },
    InvalidFormat {
        field: &'static str,
        value: String,
        expected: &'static str,
    },
    UnsafeChars {
        field: &'static str,
        value: String,
    },
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ValidationError::Empty(field) => write!(f, "{field} cannot be empty"),
            ValidationError::TooLong {
                field, max, actual, ..
            } => {
                write!(f, "{field} too long ({actual} chars, max {max})")
            }
            ValidationError::InvalidFormat {
                field,
                value,
                expected,
            } => {
                write!(f, "invalid {field} '{value}', expected {expected}")
            }
            ValidationError::UnsafeChars { field, value } => {
                write!(f, "{field} '{value}' contains shell metacharacters")
            }
        }
    }
}

impl std::error::Error for ValidationError {}

/// Validate a review ID (e.g., `cr-2rnh`).
pub fn validate_review_id(id: &str) -> Result<(), ValidationError> {
    if id.is_empty() {
        return Err(ValidationError::Empty("review ID"));
    }
    let valid = id.starts_with("cr-")
        && id.len() > 3
        && id[3..].chars().all(|c| c.is_ascii_alphanumeric());
    if !valid {
        return Err(ValidationError::InvalidFormat {
            field: "review ID",
            value: id.to_string(),
            expected: "cr-[a-z0-9]+",
        });
    }
    Ok(())
}

/// Ensure a structural value is safe for direct shell interpolation.
///
/// Structural values (bead IDs, workspace names, project names, statuses, labels)
/// are expected to be pre-validated identifiers. As defense-in-depth, if a value
/// contains shell metacharacters, it is escaped rather than interpolated raw.
fn safe_ident(value: &str) -> std::borrow::Cow<'_, str> {
    if !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | ':'))
    {
        std::borrow::Cow::Borrowed(value)
    } else {
        std::borrow::Cow::Owned(shell_escape(value))
    }
}

// --- Command builders ---
// These produce shell-safe command strings. All dynamic values are validated
// or escaped before inclusion. Structural identifiers pass through safe_ident()
// for defense-in-depth against unvalidated callers.

/// Build: `bus claims stake --agent $AGENT "bead://<project>/<id>" -m "<memo>"`
pub fn claims_stake_cmd(agent_var: &str, uri: &str, memo: &str) -> String {
    let mut cmd = String::new();
    write!(cmd, "bus claims stake --agent ${agent_var} {}", shell_escape(uri)).unwrap();
    if !memo.is_empty() {
        write!(cmd, " -m {}", shell_escape(memo)).unwrap();
    }
    cmd
}

/// Build: `bus claims release --agent $AGENT "<uri>"`
pub fn claims_release_cmd(agent_var: &str, uri: &str) -> String {
    format!(
        "bus claims release --agent ${agent_var} {}",
        shell_escape(uri)
    )
}

/// Build: `bus claims release --agent $AGENT --all`
pub fn claims_release_all_cmd(agent_var: &str) -> String {
    format!("bus claims release --agent ${agent_var} --all")
}

/// Build: `bus send --agent $AGENT <project> '<message>' -L <label>`
pub fn bus_send_cmd(agent_var: &str, project: &str, message: &str, label: &str) -> String {
    let mut cmd = String::new();
    write!(
        cmd,
        "bus send --agent ${agent_var} {} {}",
        safe_ident(project),
        shell_escape(message)
    )
    .unwrap();
    if !label.is_empty() {
        write!(cmd, " -L {}", safe_ident(label)).unwrap();
    }
    cmd
}

/// Build: `maw exec default -- br update --actor $AGENT <id> --status=<status> [--owner=$AGENT]`
pub fn br_update_cmd(
    agent_var: &str,
    bead_id: &str,
    status: &str,
    set_owner: bool,
) -> String {
    let mut cmd = format!(
        "maw exec default -- br update --actor ${agent_var} {} --status={}",
        safe_ident(bead_id),
        safe_ident(status)
    );
    if set_owner {
        write!(cmd, " --owner=${agent_var}").unwrap();
    }
    cmd
}

/// Build: `maw exec default -- br comments add --actor $AGENT --author $AGENT <id> '<message>'`
pub fn br_comment_cmd(agent_var: &str, bead_id: &str, message: &str) -> String {
    format!(
        "maw exec default -- br comments add --actor ${agent_var} --author ${agent_var} {} {}",
        safe_ident(bead_id),
        shell_escape(message)
    )
}

/// Build: `maw exec default -- br close --actor $AGENT <id> --reason='<reason>'`
pub fn br_close_cmd(agent_var: &str, bead_id: &str, reason: &str) -> String {
    format!(
        "maw exec default -- br close --actor ${agent_var} {} --reason={}",
        safe_ident(bead_id),
        shell_escape(reason)
    )
}

/// Build: `maw ws create --random`
pub fn ws_create_cmd() -> String {
    "maw ws create --random".to_string()
}

/// Build: `maw ws merge <ws> --destroy`
pub fn ws_merge_cmd(workspace: &str) -> String {
    format!("maw ws merge {} --destroy", safe_ident(workspace))
}

/// Build: `maw exec default -- br sync --flush-only`
pub fn br_sync_cmd() -> String {
    "maw exec default -- br sync --flush-only".to_string()
}

/// Build: `maw exec <ws> -- crit reviews create --agent $AGENT --title '<title>' --reviewers <reviewers>`
pub fn crit_create_cmd(
    workspace: &str,
    agent_var: &str,
    title: &str,
    reviewers: &str,
) -> String {
    format!(
        "maw exec {} -- crit reviews create --agent ${agent_var} --title {} --reviewers {}",
        safe_ident(workspace),
        shell_escape(title),
        safe_ident(reviewers)
    )
}

/// Build: `maw exec <ws> -- crit reviews request <id> --reviewers <reviewers> --agent $AGENT`
pub fn crit_request_cmd(
    workspace: &str,
    review_id: &str,
    reviewers: &str,
    agent_var: &str,
) -> String {
    format!(
        "maw exec {} -- crit reviews request {} --reviewers {} --agent ${agent_var}",
        safe_ident(workspace),
        safe_ident(review_id),
        safe_ident(reviewers)
    )
}

/// Build: `maw exec <ws> -- crit review <id>`
pub fn crit_show_cmd(workspace: &str, review_id: &str) -> String {
    format!(
        "maw exec {} -- crit review {}",
        safe_ident(workspace),
        safe_ident(review_id)
    )
}

/// Build: `bus statuses clear --agent $AGENT`
pub fn bus_statuses_clear_cmd(agent_var: &str) -> String {
    format!("bus statuses clear --agent ${agent_var}")
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- shell_escape tests ---

    #[test]
    fn escape_empty() {
        assert_eq!(shell_escape(""), "''");
    }

    #[test]
    fn escape_simple() {
        assert_eq!(shell_escape("hello"), "'hello'");
    }

    #[test]
    fn escape_with_spaces() {
        assert_eq!(shell_escape("hello world"), "'hello world'");
    }

    #[test]
    fn escape_single_quotes() {
        assert_eq!(shell_escape("it's here"), "'it'\\''s here'");
    }

    #[test]
    fn escape_double_quotes() {
        assert_eq!(shell_escape(r#"say "hi""#), r#"'say "hi"'"#);
    }

    #[test]
    fn escape_backslashes() {
        assert_eq!(shell_escape(r"path\to\file"), r"'path\to\file'");
    }

    #[test]
    fn escape_newlines() {
        assert_eq!(shell_escape("line1\nline2"), "'line1\nline2'");
    }

    #[test]
    fn escape_dollar_variables() {
        assert_eq!(shell_escape("$HOME"), "'$HOME'");
    }

    #[test]
    fn escape_backticks() {
        assert_eq!(shell_escape("`whoami`"), "'`whoami`'");
    }

    #[test]
    fn escape_unicode() {
        assert_eq!(shell_escape("hello 🌍"), "'hello 🌍'");
    }

    #[test]
    fn escape_multiple_single_quotes() {
        assert_eq!(shell_escape("it's Bob's"), "'it'\\''s Bob'\\''s'");
    }

    #[test]
    fn escape_all_metacharacters() {
        assert_eq!(
            shell_escape("$(rm -rf /)"),
            "'$(rm -rf /)'"
        );
    }

    // --- validate_bead_id tests ---

    #[test]
    fn valid_bead_id() {
        assert!(validate_bead_id("bd-3cqv").is_ok());
        assert!(validate_bead_id("bd-abc123").is_ok());
        assert!(validate_bead_id("bd-a").is_ok());
    }

    #[test]
    fn invalid_bead_id_empty() {
        assert!(validate_bead_id("").is_err());
    }

    #[test]
    fn invalid_bead_id_no_prefix() {
        assert!(validate_bead_id("3cqv").is_err());
        assert!(validate_bead_id("xx-3cqv").is_err());
    }

    #[test]
    fn invalid_bead_id_special_chars() {
        assert!(validate_bead_id("bd-abc-def").is_err());
        assert!(validate_bead_id("bd-abc def").is_err());
        assert!(validate_bead_id("bd-").is_err());
    }

    // --- validate_review_id tests ---

    #[test]
    fn valid_review_id() {
        assert!(validate_review_id("cr-2rnh").is_ok());
        assert!(validate_review_id("cr-abc123").is_ok());
        assert!(validate_review_id("cr-a").is_ok());
    }

    #[test]
    fn invalid_review_id_empty() {
        assert!(validate_review_id("").is_err());
    }

    #[test]
    fn invalid_review_id_no_prefix() {
        assert!(validate_review_id("2rnh").is_err());
        assert!(validate_review_id("bd-3cqv").is_err());
    }

    #[test]
    fn invalid_review_id_special_chars() {
        assert!(validate_review_id("cr-abc-def").is_err());
        assert!(validate_review_id("cr-").is_err());
    }

    // --- safe_ident tests ---

    #[test]
    fn safe_ident_passes_clean_values() {
        assert_eq!(safe_ident("bd-3cqv").as_ref(), "bd-3cqv");
        assert_eq!(safe_ident("frost-castle").as_ref(), "frost-castle");
        assert_eq!(safe_ident("in_progress").as_ref(), "in_progress");
        assert_eq!(safe_ident("botbox-dev").as_ref(), "botbox-dev");
    }

    #[test]
    fn safe_ident_escapes_unsafe_values() {
        // Spaces get escaped
        assert_eq!(safe_ident("bad name").as_ref(), "'bad name'");
        // Shell metacharacters get escaped
        assert_eq!(safe_ident("$(rm -rf)").as_ref(), "'$(rm -rf)'");
        // Empty gets escaped
        assert_eq!(safe_ident("").as_ref(), "''");
    }

    // --- validate_workspace_name tests ---

    #[test]
    fn valid_workspace_names() {
        assert!(validate_workspace_name("default").is_ok());
        assert!(validate_workspace_name("frost-castle").is_ok());
        assert!(validate_workspace_name("a").is_ok());
        assert!(validate_workspace_name("ws-123-test").is_ok());
    }

    #[test]
    fn invalid_workspace_empty() {
        assert!(validate_workspace_name("").is_err());
    }

    #[test]
    fn invalid_workspace_starts_with_dash() {
        assert!(validate_workspace_name("-foo").is_err());
    }

    #[test]
    fn invalid_workspace_special_chars() {
        assert!(validate_workspace_name("ws name").is_err());
        assert!(validate_workspace_name("ws_name").is_err());
        assert!(validate_workspace_name("ws.name").is_err());
    }

    #[test]
    fn invalid_workspace_too_long() {
        let long_name: String = "a".repeat(65);
        assert!(validate_workspace_name(&long_name).is_err());
    }

    #[test]
    fn workspace_exactly_64_chars() {
        let name: String = "a".repeat(64);
        assert!(validate_workspace_name(&name).is_ok());
    }

    // --- validate_identifier tests ---

    #[test]
    fn valid_identifiers() {
        assert!(validate_identifier("agent", "botbox-dev").is_ok());
        assert!(validate_identifier("project", "myproject").is_ok());
        assert!(validate_identifier("agent", "my-agent-123").is_ok());
    }

    #[test]
    fn invalid_identifier_empty() {
        assert!(validate_identifier("agent", "").is_err());
    }

    #[test]
    fn invalid_identifier_shell_metacharacters() {
        assert!(validate_identifier("agent", "foo bar").is_err());
        assert!(validate_identifier("agent", "foo;rm").is_err());
        assert!(validate_identifier("agent", "$(whoami)").is_err());
        assert!(validate_identifier("agent", "foo`bar`").is_err());
        assert!(validate_identifier("agent", "foo'bar").is_err());
        assert!(validate_identifier("agent", "foo\"bar").is_err());
        assert!(validate_identifier("agent", "a|b").is_err());
        assert!(validate_identifier("agent", "a&b").is_err());
    }

    // --- Command builder tests ---

    #[test]
    fn claims_stake_basic() {
        let cmd = claims_stake_cmd("AGENT", "bead://myproject/bd-abc", "bd-abc");
        assert_eq!(
            cmd,
            "bus claims stake --agent $AGENT 'bead://myproject/bd-abc' -m 'bd-abc'"
        );
    }

    #[test]
    fn claims_stake_no_memo() {
        let cmd = claims_stake_cmd("AGENT", "bead://myproject/bd-abc", "");
        assert_eq!(
            cmd,
            "bus claims stake --agent $AGENT 'bead://myproject/bd-abc'"
        );
    }

    #[test]
    fn claims_release_basic() {
        let cmd = claims_release_cmd("AGENT", "bead://myproject/bd-abc");
        assert_eq!(
            cmd,
            "bus claims release --agent $AGENT 'bead://myproject/bd-abc'"
        );
    }

    #[test]
    fn claims_release_all() {
        let cmd = claims_release_all_cmd("AGENT");
        assert_eq!(cmd, "bus claims release --agent $AGENT --all");
    }

    #[test]
    fn bus_send_basic() {
        let cmd = bus_send_cmd("AGENT", "myproject", "Task claimed: bd-abc", "task-claim");
        assert_eq!(
            cmd,
            "bus send --agent $AGENT myproject 'Task claimed: bd-abc' -L task-claim"
        );
    }

    #[test]
    fn bus_send_with_quotes_in_message() {
        let cmd = bus_send_cmd("AGENT", "myproject", "it's done", "task-done");
        assert_eq!(
            cmd,
            "bus send --agent $AGENT myproject 'it'\\''s done' -L task-done"
        );
    }

    #[test]
    fn bus_send_no_label() {
        let cmd = bus_send_cmd("AGENT", "myproject", "hello", "");
        assert_eq!(cmd, "bus send --agent $AGENT myproject 'hello'");
    }

    #[test]
    fn br_update_with_owner() {
        let cmd = br_update_cmd("AGENT", "bd-abc", "in_progress", true);
        assert_eq!(
            cmd,
            "maw exec default -- br update --actor $AGENT bd-abc --status=in_progress --owner=$AGENT"
        );
    }

    #[test]
    fn br_update_without_owner() {
        let cmd = br_update_cmd("AGENT", "bd-abc", "in_progress", false);
        assert_eq!(
            cmd,
            "maw exec default -- br update --actor $AGENT bd-abc --status=in_progress"
        );
    }

    #[test]
    fn br_comment_with_escaping() {
        let cmd = br_comment_cmd("AGENT", "bd-abc", "Started work in ws/frost-castle/");
        assert_eq!(
            cmd,
            "maw exec default -- br comments add --actor $AGENT --author $AGENT bd-abc 'Started work in ws/frost-castle/'"
        );
    }

    #[test]
    fn br_close_basic() {
        let cmd = br_close_cmd("AGENT", "bd-abc", "Completed");
        assert_eq!(
            cmd,
            "maw exec default -- br close --actor $AGENT bd-abc --reason='Completed'"
        );
    }

    #[test]
    fn ws_merge_basic() {
        let cmd = ws_merge_cmd("frost-castle");
        assert_eq!(cmd, "maw ws merge frost-castle --destroy");
    }

    #[test]
    fn crit_create_with_escaping() {
        let cmd = crit_create_cmd("frost-castle", "AGENT", "feat: add login", "myproject-security");
        assert_eq!(
            cmd,
            "maw exec frost-castle -- crit reviews create --agent $AGENT --title 'feat: add login' --reviewers myproject-security"
        );
    }

    #[test]
    fn crit_request_basic() {
        let cmd = crit_request_cmd("frost-castle", "cr-123", "myproject-security", "AGENT");
        assert_eq!(
            cmd,
            "maw exec frost-castle -- crit reviews request cr-123 --reviewers myproject-security --agent $AGENT"
        );
    }

    #[test]
    fn crit_show_basic() {
        let cmd = crit_show_cmd("frost-castle", "cr-123");
        assert_eq!(cmd, "maw exec frost-castle -- crit review cr-123");
    }

    // --- Deterministic output tests ---

    #[test]
    fn command_builders_are_deterministic() {
        // Same inputs always produce same output
        let cmd1 = bus_send_cmd("AGENT", "proj", "msg", "label");
        let cmd2 = bus_send_cmd("AGENT", "proj", "msg", "label");
        assert_eq!(cmd1, cmd2);
    }

    // --- Injection resistance tests ---

    #[test]
    fn escape_prevents_command_injection() {
        // Malicious input with embedded quotes gets properly escaped
        let malicious = "done'; rm -rf /; echo '";
        let escaped = shell_escape(malicious);
        // The escaped value starts and ends with single quotes
        assert!(escaped.starts_with('\''));
        assert!(escaped.ends_with('\''));
        // Embedded single quotes are broken out with \'
        assert!(escaped.contains("\\'"));
        // When used in a command, the entire escaped value appears as one arg
        let cmd = br_comment_cmd("AGENT", "bd-abc", malicious);
        assert!(cmd.contains(&escaped));
        // Roundtrip: the escaped form should decode back to the original
        // (verified by the start/end quotes and \' escaping pattern)
    }

    #[test]
    fn escape_prevents_variable_expansion() {
        let msg = "Status: $HOME/.secret";
        let escaped = shell_escape(msg);
        assert_eq!(escaped, "'Status: $HOME/.secret'");
    }
}
