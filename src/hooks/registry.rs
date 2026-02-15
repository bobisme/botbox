use crate::config::ToolsConfig;

/// Claude Code hook event type
#[derive(Debug, Clone, PartialEq)]
pub enum HookEvent {
    SessionStart,
    PreCompact,
    PostToolUse,
    SessionEnd,
}

impl HookEvent {
    pub fn as_str(&self) -> &'static str {
        match self {
            HookEvent::SessionStart => "SessionStart",
            HookEvent::PreCompact => "PreCompact",
            HookEvent::PostToolUse => "PostToolUse",
            HookEvent::SessionEnd => "SessionEnd",
        }
    }
}

/// Hook registry entry
#[derive(Debug, Clone)]
pub struct HookEntry {
    pub name: &'static str,
    pub events: &'static [HookEvent],
}

impl HookEntry {
    /// Check if this hook is eligible based on enabled tools
    pub fn is_eligible(&self, tools: &ToolsConfig) -> bool {
        match self.name {
            "init-agent" | "check-bus-inbox" | "claim-agent" => tools.botbus,
            "check-jj" => tools.maw,
            _ => false,
        }
    }
}

/// Global hook registry (static lifetime, analogous to JS HOOK_REGISTRY)
pub struct HookRegistry;

impl HookRegistry {
    /// Get all registered hooks
    pub fn all() -> Vec<HookEntry> {
        vec![
            HookEntry {
                name: "init-agent",
                events: &[HookEvent::SessionStart, HookEvent::PreCompact],
            },
            HookEntry {
                name: "check-jj",
                events: &[HookEvent::SessionStart, HookEvent::PreCompact],
            },
            HookEntry {
                name: "check-bus-inbox",
                events: &[HookEvent::PostToolUse],
            },
            HookEntry {
                name: "claim-agent",
                events: &[
                    HookEvent::SessionStart,
                    HookEvent::PostToolUse,
                    HookEvent::SessionEnd,
                ],
            },
        ]
    }

    /// Get eligible hooks for a given tools configuration
    pub fn eligible(tools: &ToolsConfig) -> Vec<HookEntry> {
        Self::all()
            .into_iter()
            .filter(|entry| entry.is_eligible(tools))
            .collect()
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_hooks_registered() {
        let hooks = HookRegistry::all();
        assert_eq!(hooks.len(), 4);
        assert!(hooks.iter().any(|h| h.name == "init-agent"));
        assert!(hooks.iter().any(|h| h.name == "check-jj"));
        assert!(hooks.iter().any(|h| h.name == "check-bus-inbox"));
        assert!(hooks.iter().any(|h| h.name == "claim-agent"));
    }

    #[test]
    fn eligibility_botbus_only() {
        let tools = ToolsConfig {
            botbus: true,
            ..Default::default()
        };
        let eligible = HookRegistry::eligible(&tools);
        assert_eq!(eligible.len(), 3);
        assert!(eligible.iter().any(|h| h.name == "init-agent"));
        assert!(eligible.iter().any(|h| h.name == "check-bus-inbox"));
        assert!(eligible.iter().any(|h| h.name == "claim-agent"));
        assert!(!eligible.iter().any(|h| h.name == "check-jj"));
    }

    #[test]
    fn eligibility_maw_only() {
        let tools = ToolsConfig {
            maw: true,
            ..Default::default()
        };
        let eligible = HookRegistry::eligible(&tools);
        assert_eq!(eligible.len(), 1);
        assert!(eligible.iter().any(|h| h.name == "check-jj"));
    }

    #[test]
    fn eligibility_all_tools() {
        let tools = ToolsConfig {
            beads: true,
            maw: true,
            crit: true,
            botbus: true,
            botty: true,
        };
        let eligible = HookRegistry::eligible(&tools);
        assert_eq!(eligible.len(), 4);
    }

    #[test]
    fn eligibility_no_tools() {
        let tools = ToolsConfig::default();
        let eligible = HookRegistry::eligible(&tools);
        assert_eq!(eligible.len(), 0);
    }

}
