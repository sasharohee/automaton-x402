/**
 * Provider-Mode Policy Rules
 *
 * Defense in depth for standalone mode (no Conway): even if a tool that
 * moves money between agents or replicates the automaton is somehow
 * offered/invoked, it is denied. Replication is also denied whenever
 * maxChildren is 0 (the default).
 */

import type { PolicyRule, PolicyRequest, PolicyRuleResult } from "../../types.js";
import { STANDALONE_FORBIDDEN_TOOLS, isStandalone } from "../../conway/provider.js";

function createStandaloneForbiddenRule(): PolicyRule {
  return {
    id: "provider.standalone_forbidden",
    description: "Deny spawn/fund/transfer and upstream-update tools in standalone (no Conway) mode",
    priority: 100,
    appliesTo: { by: "name", names: [...STANDALONE_FORBIDDEN_TOOLS] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      if (!isStandalone(request.context.config)) return null;
      return {
        rule: "provider.standalone_forbidden",
        action: "deny",
        reasonCode: "PROVIDER_UNSUPPORTED",
        humanMessage: `${request.tool.name} is disabled in standalone mode (no Conway credits, no replication, no upstream code updates).`,
      };
    },
  };
}

function createReplicationDisabledRule(): PolicyRule {
  return {
    id: "provider.replication_disabled",
    description: "Deny spawning children when maxChildren is 0",
    priority: 100,
    appliesTo: { by: "name", names: ["spawn_child"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const max = request.context.config.maxChildren ?? 0;
      if (max > 0) return null;
      return {
        rule: "provider.replication_disabled",
        action: "deny",
        reasonCode: "REPLICATION_DISABLED",
        humanMessage: "Replication is disabled (maxChildren is 0).",
      };
    },
  };
}

export function createProviderModeRules(): PolicyRule[] {
  return [createStandaloneForbiddenRule(), createReplicationDisabledRule()];
}
