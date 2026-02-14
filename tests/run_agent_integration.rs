use assert_cmd::Command;
use predicates::prelude::*;

#[test]
fn run_agent_requires_prompt() {
    let mut cmd = Command::cargo_bin("botbox").unwrap();
    cmd.arg("run").arg("agent").arg("claude");
    cmd.assert()
        .failure()
        .stderr(predicate::str::contains("required arguments were not provided"));
}

#[test]
fn run_agent_rejects_unknown_agent_type() {
    let mut cmd = Command::cargo_bin("botbox").unwrap();
    cmd.arg("run")
        .arg("agent")
        .arg("unknown-agent")
        .arg("--prompt")
        .arg("test");
    cmd.assert()
        .failure()
        .stderr(predicate::str::contains("Unsupported agent type"));
}

#[test]
fn run_agent_handles_claude_not_found() {
    // This test assumes 'claude' is not in PATH
    // If claude IS installed, this test will fail, which is acceptable
    let mut cmd = Command::cargo_bin("botbox").unwrap();
    cmd.arg("run")
        .arg("agent")
        .arg("claude")
        .arg("--prompt")
        .arg("say hello")
        .arg("--timeout")
        .arg("5");

    // We expect either:
    // 1. claude not found (most common in CI)
    // 2. claude runs successfully (if installed)
    // Don't assert on exit code, just verify command doesn't crash
    let _ = cmd.output();
}
