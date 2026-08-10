/**
 * gateway/orchestrator.ts
 *
 * OpenClaw Gateway agent orchestration (HLD Sec 7.1: "Agent orchestration").
 * Routes each inbound message through the Agent Workflow (HLD Sec 8):
 * Intent Detection -> Tool Selection -> Knowledge Search -> Gemini ->
 * Response — for messages on the public AI Secretary number
 * (`handleResidentEvent`) — and a separate, much simpler command handler
 * for the private Human Secretary number (`handleSecretaryEvent`, HLD Sec
 * 4, 9: approvals/escalations). gateway/inboundProcessor.ts decides which
 * one a given event goes to, based on which number it arrived on
 * (`toPhoneNumberId` vs config/env.ts WHATSAPP_SECRETARY_PHONE_NUMBER_ID).
 *
 * Scope boundary: secretary-number messages are handled here via a small
 * command grammar (`approve <ref>`, `ack`/`resolve <ref>`,
 * `pending escalations`/`open escalations`, `schedule <ISO-datetime>
 * <text>`, else "draft a new announcement") but are **not** written to
 * memory/conversationStore.ts — that table's `conversations.resident_id`
 * is a NOT NULL FK to `residents`, and the secretary is not a resident.
 * Session management (gateway/session.ts) still applies to both numbers,
 * since Redis sessions aren't tied to that schema.
 */
import type { Logger } from 'pino';
import { detectIntent, type Intent } from '../agent/intentRouter.js';
import { enforceForbiddenActionGuardrail, type AuditLogWriter } from '../agent/guardrails.js';
import { checkMandatoryEscalation, escalateForReason } from '../agent/escalation.js';
import type { GeminiResponder } from '../agent/gemini.js';
import { createFaqModule } from '../modules/faq.js';
import { createComplaintModule, extractTicketId } from '../modules/complaints.js';
import { createSuggestionModule, type SuggestionClassifier } from '../modules/suggestions.js';
import { createEscalationModule } from '../modules/escalation.js';
import {
  createBroadcastModule,
  type LanguageImprover,
  type BroadcastScheduler,
} from '../modules/broadcast.js';
import type { ConversationStore } from '../memory/conversationStore.js';
import type { BroadcastAttachment, WhatsAppInboundEvent } from '../tools/whatsappTool.js';
import type { ToolRegistry } from './toolRegistry.js';
import type { SessionStore } from './session.js';

export interface ResidentEventContext {
  residentId: string;
  whatsappThreadId: string;
}

export interface OrchestratorDeps {
  toolRegistry: ToolRegistry;
  conversationStore: Pick<ConversationStore, 'appendMessage' | 'getRecentHistoryForPrompt'>;
  sessionStore: SessionStore;
  geminiResponder: GeminiResponder;
  /** Writes the audit_logs row when a forbidden-action request is blocked (HLD Sec 16), or when a broadcast is sent (HLD Sec 6.1, 15). */
  auditLog: Pick<AuditLogWriter, 'logForbiddenActionBlocked' | 'logBroadcastSent' | 'logAction'>;
  /** E.164 number to notify on a new complaint (HLD Sec 6.3, 11) — config/env.ts WHATSAPP_SECRETARY_NUMBER. */
  secretaryNumber?: string;
  /** Classifies suggestion text into a category (HLD Sec 6.4) — see modules/suggestions.ts. */
  suggestionClassifier: Pick<SuggestionClassifier, 'classify'>;
  /** "AI Improves Language" for a broadcast draft (HLD Sec 9) — see modules/broadcast.ts. */
  languageImprover: Pick<LanguageImprover, 'improve'>;
  /** Defers a scheduled announcement's send to a BullMQ delayed job — see gateway/broadcastQueue.ts. */
  broadcastScheduler: Pick<BroadcastScheduler, 'scheduleBroadcast'>;
  logger?: Logger;
}

export interface Orchestrator {
  handleResidentEvent(event: WhatsAppInboundEvent, context: ResidentEventContext): Promise<void>;
  handleSecretaryEvent(event: WhatsAppInboundEvent): Promise<void>;
}

/** WhatsApp's webhook `from` is digits-only, no leading "+"; residents.phone_e164 stores E.164 with one. */
function toE164(waId: string): string {
  return waId.startsWith('+') ? waId : `+${waId}`;
}

/** Text to run intent detection / Gemini on — the message body, or a caption for media, or '' for anything else. */
function eventText(event: WhatsAppInboundEvent): string {
  switch (event.type) {
    case 'text':
      return event.text;
    case 'image':
    case 'document':
      return event.caption ?? '';
    case 'reaction':
    case 'unsupported':
      return '';
  }
}

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const log = deps.logger;
  const escalationModule = createEscalationModule({
    escalationTool: deps.toolRegistry.escalation,
    auditLog: deps.auditLog,
  });
  const faqModule = createFaqModule({
    knowledgeSearch: deps.toolRegistry.knowledgeSearch,
    geminiResponder: deps.geminiResponder,
    escalationModule,
  });
  const complaintModule = createComplaintModule({
    complaintTool: deps.toolRegistry.complaint,
    whatsapp: deps.toolRegistry.whatsapp,
    auditLog: deps.auditLog,
    ...(deps.secretaryNumber ? { secretaryNumber: deps.secretaryNumber } : {}),
  });
  const suggestionModule = createSuggestionModule({
    classifier: deps.suggestionClassifier,
    suggestionTool: deps.toolRegistry.suggestion,
    auditLog: deps.auditLog,
  });
  const broadcastModule = createBroadcastModule({
    languageImprover: deps.languageImprover,
    broadcastTool: deps.toolRegistry.broadcast,
    whatsapp: deps.toolRegistry.whatsapp,
    auditLog: deps.auditLog,
    scheduler: deps.broadcastScheduler,
  });

  async function replyAndRecord(
    event: WhatsAppInboundEvent,
    context: ResidentEventContext,
    replyText: string,
  ): Promise<void> {
    await deps.toolRegistry.whatsapp.replyMessage(event.from, replyText, event.messageId);
    await deps.conversationStore.appendMessage({
      residentId: context.residentId,
      whatsappThreadId: context.whatsappThreadId,
      direction: 'out',
      senderType: 'ai',
      body: replyText,
    });
  }

  async function handleResidentEvent(
    event: WhatsAppInboundEvent,
    context: ResidentEventContext,
  ): Promise<void> {
    const phoneE164 = toE164(event.from);
    const session = await deps.sessionStore.getOrCreateSession({
      phoneE164,
      role: 'resident',
      whatsappThreadId: context.whatsappThreadId,
      residentId: context.residentId,
    });

    const text = eventText(event).trim();
    if (!text) {
      await replyAndRecord(event, context, 'Got it — thanks for sending that!');
      return;
    }

    const escalationContext = {
      sourceType: 'query' as const,
      sourceId: session.sessionId,
      residentId: context.residentId,
    };

    // 1. Hard guardrail, checked first and unconditionally (HLD Sec 16): a
    // request to perform a forbidden action must be BLOCKED before any
    // tool call or Gemini call, and the block must be on record. See
    // agent/guardrails.ts — this both logs to audit_logs and returns the
    // action synchronously with the write, so there's no path where the
    // block happens without the log.
    const forbiddenAction = await enforceForbiddenActionGuardrail(text, deps.auditLog, {
      actorPhoneE164: phoneE164,
      sourceId: session.sessionId,
    });
    if (forbiddenAction) {
      log?.warn(
        { forbiddenAction, whatsappThreadId: context.whatsappThreadId },
        'Blocked a forbidden-action request from a resident.',
      );
      const escalation = await escalateForReason(
        `forbidden_action_request:${forbiddenAction}: ${text}`,
        escalationContext,
        escalationModule,
      );
      const actionPhrase = forbiddenAction.replace(/_/g, ' ');
      await replyAndRecord(
        event,
        context,
        `I'm not able to ${actionPhrase} myself — only the Secretary can do that. ${escalation.replyText}`,
      );
      return;
    }

    // 2. Mandatory escalation triggers (legal/police/harassment/financial —
    // HLD Sec 16). Also checked before intent detection: a guardrail match
    // always overrides whatever agent/intentRouter.ts would have said.
    const mandatoryEscalation = await checkMandatoryEscalation(
      text,
      escalationContext,
      escalationModule,
    );
    if (mandatoryEscalation) {
      log?.info(
        { trigger: mandatoryEscalation.trigger, whatsappThreadId: context.whatsappThreadId },
        'Mandatory escalation trigger matched; not answering directly.',
      );
      await replyAndRecord(event, context, mandatoryEscalation.replyText);
      return;
    }

    // 3. Complaint status-check (HLD Sec 6.3): a message referencing a
    // ticket id (e.g. "status of TCK-2026-0001") is unambiguous and takes
    // priority over the generic keyword classifier below, which has no
    // pattern that would otherwise catch this shape of message and would
    // send it down the FAQ path instead.
    const ticketId = extractTicketId(text);
    if (ticketId) {
      const outcome = await complaintModule.checkStatus(ticketId, context.residentId);
      await replyAndRecord(event, context, outcome.replyText);
      return;
    }

    const intent: Intent = detectIntent(text);

    // 4. Residents can never trigger a broadcast (HLD Sec 16: not an
    // AI/resident decision), and agent/intentRouter.ts's own generic
    // 'escalation' bucket (urgency language not matching a specific
    // trigger) still must not be answered directly.
    if (intent === 'broadcast' || intent === 'escalation') {
      const outcome = await escalateForReason(text, escalationContext, escalationModule);
      await replyAndRecord(event, context, outcome.replyText);
      return;
    }

    let replyText: string;
    switch (intent) {
      case 'complaint': {
        // No ticket id was found above, so this is a new complaint, not a
        // status check — fileComplaint directly rather than going through
        // handleMessage's dispatch (which would just re-run the same check).
        const outcome = await complaintModule.fileComplaint({
          residentId: context.residentId,
          description: text,
        });
        replyText = outcome.replyText;
        break;
      }
      case 'suggestion': {
        const outcome = await suggestionModule.submitSuggestion({
          residentId: context.residentId,
          body: text,
        });
        replyText = outcome.replyText;
        break;
      }
      case 'faq':
      default: {
        const history = await deps.conversationStore.getRecentHistoryForPrompt(
          context.whatsappThreadId,
        );
        const outcome = await faqModule.answerQuestion(text, history, escalationContext);
        replyText = outcome.replyText;
        break;
      }
    }

    log?.info(
      { intent, resumedSession: session.resumed, whatsappThreadId: context.whatsappThreadId },
      'Resident message handled.',
    );
    await replyAndRecord(event, context, replyText);
  }

  async function handleSecretaryEvent(event: WhatsAppInboundEvent): Promise<void> {
    const phoneE164 = toE164(event.from);
    await deps.sessionStore.getOrCreateSession({
      phoneE164,
      role: 'secretary',
      whatsappThreadId: event.from,
    });

    const text = eventText(event).trim();
    if (!text) {
      await deps.toolRegistry.whatsapp.replyMessage(event.from, 'Got it.', event.messageId);
      return;
    }

    const approveMatch = /^approve\s+(\S+)/i.exec(text);
    const ackMatch = /^(ack|resolve)\s+(\S+)/i.exec(text);
    const scheduleMatch = /^schedule\s+(\S+)\s+([\s\S]+)/i.exec(text);

    if (approveMatch) {
      const idPrefix = approveMatch[1]!;
      try {
        const outcome = await broadcastModule.approveAnnouncement({
          idPrefix,
          approvedBy: phoneE164,
        });
        await deps.toolRegistry.whatsapp.replyMessage(
          event.from,
          outcome.replyText,
          event.messageId,
        );
      } catch (err) {
        await deps.toolRegistry.whatsapp.replyMessage(
          event.from,
          `Couldn't approve "${idPrefix}": ${err instanceof Error ? err.message : String(err)}`,
          event.messageId,
        );
      }
      return;
    }

    if (ackMatch) {
      const status = ackMatch[1]!.toLowerCase() === 'resolve' ? 'resolved' : 'acknowledged';
      const idPrefix = ackMatch[2]!;
      try {
        const outcome = await escalationModule.acknowledge(idPrefix, status, phoneE164);
        await deps.toolRegistry.whatsapp.replyMessage(
          event.from,
          outcome.replyText,
          event.messageId,
        );
      } catch (err) {
        await deps.toolRegistry.whatsapp.replyMessage(
          event.from,
          `Couldn't update "${idPrefix}": ${err instanceof Error ? err.message : String(err)}`,
          event.messageId,
        );
      }
      return;
    }

    // "pending escalations" / "open escalations" (HLD Sec 6.5): a simple
    // query the secretary can send to list every escalation not yet
    // resolved (pending or acknowledged), instead of having to remember
    // refs from earlier notifications.
    if (/^(pending|open)\s+escalations\b/i.test(text)) {
      const outcome = await escalationModule.listOpenEscalations();
      await deps.toolRegistry.whatsapp.replyMessage(event.from, outcome.replyText, event.messageId);
      return;
    }

    // Anything else from the secretary's own number is treated as a new
    // announcement draft (HLD Sec 6.1, 9): AI improves the wording and
    // replies with a preview — never sends. The secretary approves it
    // explicitly with "approve <ref>", which is the only path that can
    // result in a send (HLD Sec 16).
    //
    // "schedule <ISO-datetime> <text>" attaches a scheduled_at, deferring
    // the send (once approved) to that time via gateway/broadcastQueue.ts's
    // delayed job instead of sending immediately on approval.
    let body = text;
    let scheduledFor: Date | undefined;
    if (scheduleMatch) {
      const parsed = new Date(scheduleMatch[1]!);
      if (Number.isNaN(parsed.getTime())) {
        await deps.toolRegistry.whatsapp.replyMessage(
          event.from,
          `Couldn't parse "${scheduleMatch[1]}" as a date/time — use an ISO timestamp, e.g. "schedule 2026-08-15T09:00:00Z Water tanker at 9am."`,
          event.messageId,
        );
        return;
      }
      scheduledFor = parsed;
      body = scheduleMatch[2]!;
    }

    // An image/document draft carries its media through as an attachment —
    // the inbound WhatsApp media id is reusable directly in an outbound
    // send, so no re-upload is needed for media the secretary already sent.
    const existingAttachments: BroadcastAttachment[] =
      event.type === 'image'
        ? [{ type: 'image', mediaId: event.mediaId }]
        : event.type === 'document'
          ? [
              {
                type: 'document',
                mediaId: event.mediaId,
                ...(event.filename ? { filename: event.filename } : {}),
              },
            ]
          : [];

    const outcome = await broadcastModule.draftAnnouncement({
      author: phoneE164,
      body,
      ...(scheduledFor ? { scheduledFor } : {}),
      ...(existingAttachments.length ? { existingAttachments } : {}),
    });
    await deps.toolRegistry.whatsapp.replyMessage(event.from, outcome.replyText, event.messageId);
  }

  return { handleResidentEvent, handleSecretaryEvent };
}
