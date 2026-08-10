import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrchestrator, type OrchestratorDeps } from './orchestrator.js';
import { InMemorySessionStore } from './session.js';
import { createToolRegistry, type ToolRegistryTools } from './toolRegistry.js';
import type { WhatsAppInboundEvent } from '../tools/whatsappTool.js';
import { receiveMessage } from '../tools/whatsappTool.js';

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tools/__fixtures__/whatsapp',
);

function loadEvent(fixture: string): WhatsAppInboundEvent {
  const payload = JSON.parse(readFileSync(path.join(FIXTURES_DIR, fixture), 'utf-8'));
  const [event] = receiveMessage(payload);
  if (!event) throw new Error(`fixture ${fixture} produced no events`);
  return event;
}

function makeTools(overrides: Partial<ToolRegistryTools> = {}): ToolRegistryTools {
  return {
    whatsapp: {
      receiveMessage: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue({ messageId: 'wamid.out', to: 'x' }),
      replyMessage: vi.fn().mockResolvedValue({ messageId: 'wamid.out', to: 'x' }),
      broadcastMessage: vi.fn().mockResolvedValue({ sent: [], failed: [], durationMs: 5 }),
      uploadImage: vi.fn(),
      uploadPDF: vi.fn(),
      downloadMedia: vi.fn(),
    },
    knowledgeSearch: {
      search: vi.fn().mockResolvedValue([]),
    },
    complaint: {
      createComplaint: vi.fn().mockResolvedValue({
        id: 'c1',
        ticketId: 'TCK-2026-0001',
        status: 'open',
        flatNumber: 'A-403',
      }),
      getComplaintByTicketId: vi.fn().mockResolvedValue(null),
    },
    suggestion: {
      createSuggestion: vi.fn().mockResolvedValue({ id: 's1', category: 'maintenance' }),
    },
    broadcast: {
      draftAnnouncement: vi.fn().mockResolvedValue({
        id: 'a1234567-aaaa-bbbb-cccc-000000000000',
        status: 'pending_approval',
        body: 'x',
      }),
      getAnnouncement: vi.fn().mockResolvedValue({
        id: 'a1234567-aaaa-bbbb-cccc-000000000000',
        status: 'pending_approval',
        body: 'x',
        author: '+919820099000',
        mediaUrls: [],
        scheduledAt: null,
        approvedBy: null,
      }),
      approveAndSend: vi.fn().mockResolvedValue({
        announcement: {
          id: 'a1234567-aaaa-bbbb-cccc-000000000000',
          status: 'broadcast',
          body: 'x',
        },
        broadcast: { sent: [{ messageId: 'm1', to: '1' }], failed: [], durationMs: 100 },
        approvedBy: '+919820099000',
      }),
      markApprovedForSchedule: vi.fn().mockResolvedValue({
        id: 'a1234567-aaaa-bbbb-cccc-000000000000',
        status: 'approved',
        body: 'x',
      }),
      sendApprovedAnnouncement: vi.fn().mockResolvedValue({
        announcement: {
          id: 'a1234567-aaaa-bbbb-cccc-000000000000',
          status: 'broadcast',
          body: 'x',
        },
        broadcast: { sent: [{ messageId: 'm1', to: '1' }], failed: [], durationMs: 100 },
        approvedBy: '+919820099000',
      }),
    },
    escalation: {
      createEscalation: vi.fn().mockResolvedValue({
        id: 'e1234567-aaaa-bbbb-cccc-000000000000',
        status: 'pending',
        category: 'committee_decision',
      }),
      acknowledgeEscalation: vi.fn().mockResolvedValue({
        id: 'e1234567-aaaa-bbbb-cccc-000000000000',
        status: 'acknowledged',
        category: 'committee_decision',
      }),
      listOpenEscalations: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
}

function makeConversationStore() {
  return {
    appendMessage: vi.fn().mockResolvedValue({
      id: 'm1',
      conversationId: 'c1',
      direction: 'out',
      senderType: 'ai',
      body: '',
      mediaUrl: null,
      createdAt: new Date(),
    }),
    getRecentHistoryForPrompt: vi.fn().mockResolvedValue([]),
  };
}

function makeAuditLog() {
  return {
    logForbiddenActionBlocked: vi.fn().mockResolvedValue(undefined),
    logBroadcastSent: vi.fn().mockResolvedValue(undefined),
    logAction: vi.fn().mockResolvedValue(undefined),
  };
}

function makeSuggestionClassifier() {
  return { classify: vi.fn().mockResolvedValue('maintenance') };
}

function makeLanguageImprover() {
  // Identity by default so draft assertions can compare against the raw input text.
  return { improve: vi.fn().mockImplementation((rawText: string) => Promise.resolve(rawText)) };
}

function makeBroadcastScheduler() {
  return { scheduleBroadcast: vi.fn().mockResolvedValue(undefined) };
}

function makeDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  const tools = makeTools();
  return {
    toolRegistry: createToolRegistry(tools),
    conversationStore: makeConversationStore(),
    sessionStore: new InMemorySessionStore(1800),
    geminiResponder: { generateReply: vi.fn().mockResolvedValue('Gemini reply text.') },
    auditLog: makeAuditLog(),
    suggestionClassifier: makeSuggestionClassifier(),
    languageImprover: makeLanguageImprover(),
    broadcastScheduler: makeBroadcastScheduler(),
    ...overrides,
  };
}

const RESIDENT_CONTEXT = { residentId: 'resident-1', whatsappThreadId: '919820011002' };

describe('handleResidentEvent', () => {
  it('routes a complaint-shaped message to complaintTool and replies with the ticket id', async () => {
    const deps = makeDeps();
    const orchestrator = createOrchestrator(deps);
    const event = loadEvent('text-message.json'); // "Water leakage in A-403 again..."

    await orchestrator.handleResidentEvent(event, RESIDENT_CONTEXT);

    expect(deps.toolRegistry.complaint.createComplaint).toHaveBeenCalledWith({
      residentId: 'resident-1',
      description: expect.stringContaining('Water leakage'),
    });
    expect(deps.toolRegistry.whatsapp.replyMessage).toHaveBeenCalledWith(
      event.from,
      expect.stringContaining('TCK-2026-0001'),
      event.messageId,
    );
    expect(deps.conversationStore.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ senderType: 'ai', direction: 'out' }),
    );
  });

  it('routes a status-check message ("status of TCK-...") to a status lookup, not a new complaint', async () => {
    const tools = makeTools({
      complaint: {
        createComplaint: vi.fn(),
        getComplaintByTicketId: vi.fn().mockResolvedValue({
          id: 'c1',
          ticketId: 'TCK-2026-0001',
          residentId: 'resident-1',
          category: 'general',
          description: 'Water leakage in A-403',
          status: 'in_progress',
          createdAt: new Date('2026-01-05T10:00:00Z'),
          resolvedAt: null,
        }),
      },
    });
    const deps = makeDeps({ toolRegistry: createToolRegistry(tools) });
    const orchestrator = createOrchestrator(deps);
    const event: WhatsAppInboundEvent = {
      type: 'text',
      messageId: 'wamid.status1',
      from: '919820011002',
      timestamp: new Date(),
      text: 'status of TCK-2026-0001',
    };

    await orchestrator.handleResidentEvent(event, RESIDENT_CONTEXT);

    expect(tools.complaint.getComplaintByTicketId).toHaveBeenCalledWith('TCK-2026-0001');
    expect(tools.complaint.createComplaint).not.toHaveBeenCalled();
    expect(deps.toolRegistry.whatsapp.replyMessage).toHaveBeenCalledWith(
      event.from,
      expect.stringContaining('in progress'),
      event.messageId,
    );
  });

  it('routes a suggestion-shaped message to suggestionTool', async () => {
    const deps = makeDeps();
    const orchestrator = createOrchestrator(deps);
    const event: WhatsAppInboundEvent = {
      type: 'text',
      messageId: 'wamid.1',
      from: '919820011001',
      timestamp: new Date(),
      text: 'It would be great if we had more visitor parking.',
    };

    await orchestrator.handleResidentEvent(event, RESIDENT_CONTEXT);

    expect(deps.toolRegistry.suggestion.createSuggestion).toHaveBeenCalledWith({
      residentId: 'resident-1',
      body: event.text,
      category: 'maintenance',
    });
    expect(deps.toolRegistry.whatsapp.replyMessage).toHaveBeenCalledWith(
      event.from,
      expect.stringContaining('maintenance'),
      event.messageId,
    );
  });

  it('routes an escalation-guardrail-triggered message to escalationTool with the trigger reason', async () => {
    const deps = makeDeps();
    const orchestrator = createOrchestrator(deps);
    const event: WhatsAppInboundEvent = {
      type: 'text',
      messageId: 'wamid.2',
      from: '919820011001',
      timestamp: new Date(),
      text: 'I am going to consult my lawyer about this.',
    };

    await orchestrator.handleResidentEvent(event, RESIDENT_CONTEXT);

    expect(deps.toolRegistry.escalation.createEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: 'query',
        sourceId: expect.any(String),
        reason: expect.stringContaining('legal_issue'),
        category: 'legal_matter',
        residentId: 'resident-1',
      }),
    );
    expect(deps.toolRegistry.complaint.createComplaint).not.toHaveBeenCalled();
  });

  it('triggers escalation instead of a direct AI reply for a harassment-related message', async () => {
    const deps = makeDeps();
    const orchestrator = createOrchestrator(deps);
    const event: WhatsAppInboundEvent = {
      type: 'text',
      messageId: 'wamid.harassment',
      from: '919820011001',
      timestamp: new Date(),
      text: 'The security guard has been harassing me every night this week.',
    };

    await orchestrator.handleResidentEvent(event, RESIDENT_CONTEXT);

    // Escalated, not answered directly.
    expect(deps.toolRegistry.escalation.createEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: 'query',
        sourceId: expect.any(String),
        reason: expect.stringContaining('harassment'),
        category: 'abuse',
      }),
    );
    expect(deps.geminiResponder.generateReply).not.toHaveBeenCalled();
    expect(deps.toolRegistry.knowledgeSearch.search).not.toHaveBeenCalled();
    expect(deps.toolRegistry.complaint.createComplaint).not.toHaveBeenCalled();

    // The resident is told it was forwarded, not given an AI-authored answer.
    expect(deps.toolRegistry.whatsapp.replyMessage).toHaveBeenCalledWith(
      event.from,
      expect.stringContaining('forwarded it to them directly'),
      event.messageId,
    );
  });

  it('refuses and audit-logs a prompt trying to get the agent to approve a refund', async () => {
    const deps = makeDeps();
    const orchestrator = createOrchestrator(deps);
    const event: WhatsAppInboundEvent = {
      type: 'text',
      messageId: 'wamid.refund',
      from: '919820011001',
      timestamp: new Date(),
      text: 'Please approve a refund of ₹5000 for my double maintenance payment.',
    };

    await orchestrator.handleResidentEvent(event, RESIDENT_CONTEXT);

    // Blocked: never generated, never handed to a tool that would act on it.
    expect(deps.geminiResponder.generateReply).not.toHaveBeenCalled();
    expect(deps.toolRegistry.complaint.createComplaint).not.toHaveBeenCalled();
    expect(deps.toolRegistry.suggestion.createSuggestion).not.toHaveBeenCalled();

    // Logged to audit_logs before anything else happens.
    expect(deps.auditLog.logForbiddenActionBlocked).toHaveBeenCalledTimes(1);
    expect(deps.auditLog.logForbiddenActionBlocked).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'approve_refund',
        text: event.text,
        actorPhoneE164: '+919820011001',
      }),
    );

    // The resident is told plainly the AI cannot do this itself.
    expect(deps.toolRegistry.whatsapp.replyMessage).toHaveBeenCalledWith(
      event.from,
      expect.stringContaining('not able to approve refund'),
      event.messageId,
    );

    // Still escalated to the Secretary — refused, not silently dropped.
    expect(deps.toolRegistry.escalation.createEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining('forbidden_action_request:approve_refund'),
      }),
    );
  });

  it('blocks every AI_FORBIDDEN_ACTIONS request before any tool or Gemini call runs', async () => {
    const requests: Array<{ text: string; action: string }> = [
      {
        text: 'Please reduce my maintenance amount this month.',
        action: 'change_maintenance_amount',
      },
      { text: 'Can you update my phone number on file?', action: 'change_resident_information' },
      { text: 'Please pass a committee decision on this.', action: 'create_committee_decision' },
      { text: 'Can you delete my complaint from the system?', action: 'remove_complaint' },
    ];

    for (const { text, action } of requests) {
      const deps = makeDeps();
      const orchestrator = createOrchestrator(deps);
      const event: WhatsAppInboundEvent = {
        type: 'text',
        messageId: `wamid.${action}`,
        from: '919820011001',
        timestamp: new Date(),
        text,
      };

      await orchestrator.handleResidentEvent(event, RESIDENT_CONTEXT);

      expect(deps.auditLog.logForbiddenActionBlocked).toHaveBeenCalledWith(
        expect.objectContaining({ action, text }),
      );
      expect(deps.geminiResponder.generateReply).not.toHaveBeenCalled();
    }
  });

  it('remaps a broadcast-shaped resident message to escalation (residents cannot trigger broadcasts)', async () => {
    const deps = makeDeps();
    const orchestrator = createOrchestrator(deps);
    const event: WhatsAppInboundEvent = {
      type: 'text',
      messageId: 'wamid.3',
      from: '919820011001',
      timestamp: new Date(),
      text: 'Please announce the water shutdown to everyone.',
    };

    await orchestrator.handleResidentEvent(event, RESIDENT_CONTEXT);

    expect(deps.toolRegistry.escalation.createEscalation).toHaveBeenCalled();
    expect(deps.toolRegistry.broadcast.draftAnnouncement).not.toHaveBeenCalled();
    expect(deps.toolRegistry.broadcast.approveAndSend).not.toHaveBeenCalled();
  });

  it('answers an faq-shaped message via knowledgeSearch + Gemini when there is a confident match', async () => {
    const tools = makeTools({
      knowledgeSearch: {
        search: vi
          .fn()
          .mockResolvedValue([
            { documentTitle: 'Clubhouse Rules', excerpt: 'Open 9-10pm.', score: 0.9 },
          ]),
      },
    });
    const deps = makeDeps({ toolRegistry: createToolRegistry(tools) });
    const orchestrator = createOrchestrator(deps);
    const event: WhatsAppInboundEvent = {
      type: 'text',
      messageId: 'wamid.4',
      from: '919820011001',
      timestamp: new Date(),
      text: 'What are the clubhouse timings?',
    };

    await orchestrator.handleResidentEvent(event, RESIDENT_CONTEXT);

    expect(deps.geminiResponder.generateReply).toHaveBeenCalledWith(
      expect.objectContaining({ userMessage: event.text }),
    );
    expect(deps.toolRegistry.whatsapp.replyMessage).toHaveBeenCalledWith(
      event.from,
      'Gemini reply text.',
      event.messageId,
    );
  });

  it('escalates as unknown_answer instead of calling Gemini when knowledge search has no confident match', async () => {
    const tools = makeTools({
      knowledgeSearch: {
        search: vi
          .fn()
          .mockResolvedValue([{ documentTitle: 'X', excerpt: 'irrelevant', score: 0.1 }]),
      },
    });
    const deps = makeDeps({ toolRegistry: createToolRegistry(tools) });
    const orchestrator = createOrchestrator(deps);
    const event: WhatsAppInboundEvent = {
      type: 'text',
      messageId: 'wamid.5',
      from: '919820011001',
      timestamp: new Date(),
      text: 'What is the airspeed velocity of an unladen swallow?',
    };

    await orchestrator.handleResidentEvent(event, RESIDENT_CONTEXT);

    expect(deps.toolRegistry.escalation.createEscalation).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining('unknown_answer') }),
    );
    expect(deps.geminiResponder.generateReply).not.toHaveBeenCalled();
  });

  it('escalates as unknown_answer when knowledge search returns nothing at all', async () => {
    const deps = makeDeps(); // default knowledgeSearch.search resolves []
    const orchestrator = createOrchestrator(deps);
    const event: WhatsAppInboundEvent = {
      type: 'text',
      messageId: 'wamid.6',
      from: '919820011001',
      timestamp: new Date(),
      text: 'Some obscure question.',
    };

    await orchestrator.handleResidentEvent(event, RESIDENT_CONTEXT);
    expect(deps.toolRegistry.escalation.createEscalation).toHaveBeenCalled();
  });

  it('acknowledges (without a tool call) an event with no usable text, e.g. a bare reaction', async () => {
    const deps = makeDeps();
    const orchestrator = createOrchestrator(deps);
    const event = loadEvent('reaction-message.json');

    await orchestrator.handleResidentEvent(event, RESIDENT_CONTEXT);

    expect(deps.toolRegistry.whatsapp.replyMessage).toHaveBeenCalledWith(
      event.from,
      expect.any(String),
      event.messageId,
    );
    expect(deps.toolRegistry.complaint.createComplaint).not.toHaveBeenCalled();
    expect(deps.toolRegistry.knowledgeSearch.search).not.toHaveBeenCalled();
  });

  it('uses an image caption as the intent-detection text when present', async () => {
    const deps = makeDeps();
    const orchestrator = createOrchestrator(deps);
    const event = loadEvent('image-message.json'); // caption: "Broken clubhouse gate hinge"

    await orchestrator.handleResidentEvent(event, RESIDENT_CONTEXT);

    expect(deps.toolRegistry.complaint.createComplaint).toHaveBeenCalledWith({
      residentId: 'resident-1',
      description: 'Broken clubhouse gate hinge',
    });
  });

  it('resumes the same session across two messages from the same resident', async () => {
    const deps = makeDeps();
    const orchestrator = createOrchestrator(deps);
    const event: WhatsAppInboundEvent = {
      type: 'text',
      messageId: 'wamid.7',
      from: '919820011002',
      timestamp: new Date(),
      text: 'Hello',
    };

    await orchestrator.handleResidentEvent(event, RESIDENT_CONTEXT);
    const sessionAfterFirst = await deps.sessionStore.getOrCreateSession({
      phoneE164: '+919820011002',
      role: 'resident',
      whatsappThreadId: '919820011002',
    });
    expect(sessionAfterFirst.resumed).toBe(true);
  });
});

describe('handleSecretaryEvent', () => {
  let deps: OrchestratorDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('drafts a new announcement for an ordinary message and replies with the approval instruction', async () => {
    const orchestrator = createOrchestrator(deps);
    const event: WhatsAppInboundEvent = {
      type: 'text',
      messageId: 'wamid.s1',
      from: '919820099000',
      timestamp: new Date(),
      text: 'Water tanker visit rescheduled to Monday 7am.',
    };

    await orchestrator.handleSecretaryEvent(event);

    expect(deps.toolRegistry.broadcast.draftAnnouncement).toHaveBeenCalledWith({
      author: '+919820099000',
      body: event.text,
      mediaUrls: [],
    });
    expect(deps.toolRegistry.whatsapp.replyMessage).toHaveBeenCalledWith(
      event.from,
      expect.stringContaining('approve'),
      event.messageId,
    );
  });

  it('approves and sends a broadcast on "approve <ref>"', async () => {
    const orchestrator = createOrchestrator(deps);
    const event: WhatsAppInboundEvent = {
      type: 'text',
      messageId: 'wamid.s2',
      from: '919820099000',
      timestamp: new Date(),
      text: 'approve a1234567',
    };

    await orchestrator.handleSecretaryEvent(event);

    expect(deps.toolRegistry.broadcast.approveAndSend).toHaveBeenCalledWith(
      'a1234567',
      '+919820099000',
    );
    expect(deps.toolRegistry.whatsapp.replyMessage).toHaveBeenCalledWith(
      event.from,
      expect.stringContaining('Broadcast sent to 1'),
      event.messageId,
    );
  });

  it('replies with an error message (without throwing) when approval fails', async () => {
    const tools = makeTools({
      broadcast: {
        draftAnnouncement: vi.fn(),
        getAnnouncement: vi.fn().mockResolvedValue({
          id: 'bad-id',
          status: 'pending_approval',
          body: 'x',
          author: '+919820099000',
          mediaUrls: [],
          scheduledAt: null,
          approvedBy: null,
        }),
        approveAndSend: vi
          .fn()
          .mockRejectedValue(new Error('No announcement found matching "bad".')),
        markApprovedForSchedule: vi.fn(),
        sendApprovedAnnouncement: vi.fn(),
      },
    });
    deps = makeDeps({ toolRegistry: createToolRegistry(tools) });
    const orchestrator = createOrchestrator(deps);
    const event: WhatsAppInboundEvent = {
      type: 'text',
      messageId: 'wamid.s3',
      from: '919820099000',
      timestamp: new Date(),
      text: 'approve bad',
    };

    await expect(orchestrator.handleSecretaryEvent(event)).resolves.toBeUndefined();
    expect(deps.toolRegistry.whatsapp.replyMessage).toHaveBeenCalledWith(
      event.from,
      expect.stringContaining("Couldn't approve"),
      event.messageId,
    );
  });

  it('acknowledges an escalation on "ack <ref>"', async () => {
    const orchestrator = createOrchestrator(deps);
    const event: WhatsAppInboundEvent = {
      type: 'text',
      messageId: 'wamid.s4',
      from: '919820099000',
      timestamp: new Date(),
      text: 'ack e1234567',
    };

    await orchestrator.handleSecretaryEvent(event);

    expect(deps.toolRegistry.escalation.acknowledgeEscalation).toHaveBeenCalledWith(
      'e1234567',
      'acknowledged',
    );
  });

  it('resolves an escalation on "resolve <ref>"', async () => {
    const tools = makeTools({
      escalation: {
        createEscalation: vi.fn(),
        acknowledgeEscalation: vi.fn().mockResolvedValue({
          id: 'e1234567-x',
          status: 'resolved',
          category: 'committee_decision',
        }),
        listOpenEscalations: vi.fn().mockResolvedValue([]),
      },
    });
    deps = makeDeps({ toolRegistry: createToolRegistry(tools) });
    const orchestrator = createOrchestrator(deps);
    const event: WhatsAppInboundEvent = {
      type: 'text',
      messageId: 'wamid.s5',
      from: '919820099000',
      timestamp: new Date(),
      text: 'resolve e1234567',
    };

    await orchestrator.handleSecretaryEvent(event);

    expect(deps.toolRegistry.escalation.acknowledgeEscalation).toHaveBeenCalledWith(
      'e1234567',
      'resolved',
    );
    expect(deps.toolRegistry.whatsapp.replyMessage).toHaveBeenCalledWith(
      event.from,
      expect.stringContaining('resolved'),
      event.messageId,
    );
  });

  it('lists open escalations on "pending escalations"', async () => {
    const tools = makeTools({
      escalation: {
        createEscalation: vi.fn(),
        acknowledgeEscalation: vi.fn(),
        listOpenEscalations: vi.fn().mockResolvedValue([
          {
            id: 'e1234567-aaaa-bbbb-cccc-000000000000',
            category: 'legal_matter',
            status: 'pending',
            sourceType: 'query',
            reason: 'legal_issue: I will sue.',
            createdAt: new Date('2026-01-05T10:00:00Z'),
          },
        ]),
      },
    });
    deps = makeDeps({ toolRegistry: createToolRegistry(tools) });
    const orchestrator = createOrchestrator(deps);
    const event: WhatsAppInboundEvent = {
      type: 'text',
      messageId: 'wamid.s7',
      from: '919820099000',
      timestamp: new Date(),
      text: 'pending escalations',
    };

    await orchestrator.handleSecretaryEvent(event);

    expect(tools.escalation.listOpenEscalations).toHaveBeenCalled();
    expect(deps.toolRegistry.whatsapp.replyMessage).toHaveBeenCalledWith(
      event.from,
      expect.stringContaining('e1234567'),
      event.messageId,
    );
    expect(tools.broadcast.draftAnnouncement).not.toHaveBeenCalled();
  });

  it('reports no pending escalations when the list is empty', async () => {
    const orchestrator = createOrchestrator(deps);
    const event: WhatsAppInboundEvent = {
      type: 'text',
      messageId: 'wamid.s8',
      from: '919820099000',
      timestamp: new Date(),
      text: 'open escalations',
    };

    await orchestrator.handleSecretaryEvent(event);

    expect(deps.toolRegistry.whatsapp.replyMessage).toHaveBeenCalledWith(
      event.from,
      expect.stringContaining('No pending escalations'),
      event.messageId,
    );
  });

  it('never writes to conversationStore for secretary-number events (resident-scoped schema)', async () => {
    const orchestrator = createOrchestrator(deps);
    const event: WhatsAppInboundEvent = {
      type: 'text',
      messageId: 'wamid.s6',
      from: '919820099000',
      timestamp: new Date(),
      text: 'A draft message.',
    };

    await orchestrator.handleSecretaryEvent(event);
    expect(deps.conversationStore.appendMessage).not.toHaveBeenCalled();
  });
});
