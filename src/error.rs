use std::process::ExitCode;

/// Errors that cause botbox to exit with a specific code.
#[derive(Debug, thiserror::Error)]
pub enum ExitError {
    #[error("config error: {0}")]
    Config(String),

    #[error("tool not found: {tool}")]
    ToolNotFound { tool: String },

    #[error("{tool} failed (exit {code}): {message}")]
    ToolFailed {
        tool: String,
        code: i32,
        message: String,
    },

    #[error("{tool} timed out after {timeout_secs}s")]
    Timeout { tool: String, timeout_secs: u64 },

    #[error("{0}")]
    Other(String),
}

impl ExitError {
    pub fn exit_code(&self) -> ExitCode {
        match self {
            ExitError::Config(_) => ExitCode::from(2),
            ExitError::ToolNotFound { .. } => ExitCode::from(3),
            ExitError::ToolFailed { .. } => ExitCode::from(4),
            ExitError::Timeout { .. } => ExitCode::from(5),
            ExitError::Other(_) => ExitCode::from(1),
        }
    }
}
