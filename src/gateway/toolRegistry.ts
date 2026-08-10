/**
 * gateway/toolRegistry.ts
 *
 * OpenClaw Gateway tool registry (HLD Sec 7.1: "Tool execution"). Registers
 * the six tools from HLD Sec 6/7.3 under one typed lookup so
 * gateway/orchestrator.ts's "Tool Selection" step (HLD Sec 8) can go from
 * an `Intent` straight to a callable tool without a provider-specific
 * branch anywhere else.
 */
import type { WhatsAppTool } from '../tools/whatsappTool.js';
import type { KnowledgeSearchTool } from '../tools/knowledgeSearchTool.js';
import type { ComplaintTool } from '../tools/complaintTool.js';
import type { SuggestionTool } from '../tools/suggestionTool.js';
import type { BroadcastTool } from '../tools/broadcastTool.js';
import type { EscalationTool } from '../tools/escalationTool.js';

export interface ToolRegistryTools {
  whatsapp: WhatsAppTool;
  knowledgeSearch: KnowledgeSearchTool;
  complaint: ComplaintTool;
  suggestion: SuggestionTool;
  broadcast: BroadcastTool;
  escalation: EscalationTool;
}

export type ToolName = keyof ToolRegistryTools;

export interface ToolRegistry extends ToolRegistryTools {
  get<K extends ToolName>(name: K): ToolRegistryTools[K];
  list(): ToolName[];
}

/** Registers a fixed set of tool instances (already constructed with their own deps) under one lookup. */
export function createToolRegistry(tools: ToolRegistryTools): ToolRegistry {
  return {
    ...tools,
    get(name) {
      return tools[name];
    },
    list() {
      return Object.keys(tools) as ToolName[];
    },
  };
}
