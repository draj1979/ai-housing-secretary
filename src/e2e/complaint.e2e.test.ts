/**
 * e2e/complaint.e2e.test.ts
 *
 * HLD Sec 11 — Complaint Workflow: "Resident -> Complaint -> AI -> Database
 * -> Ticket Created -> Secretary Notified -> Resident Gets Ticket". End to
 * end through `gateway/orchestrator.ts`'s real `handleResidentEvent` and
 * real `modules/complaints.ts` — only WhatsApp/the DB-backed complaint tool
 * are faked (see testHarness.ts's doc comment).
 */
import { describe, expect, it, vi } from 'vitest';
import { NFR_TARGETS } from '../config/constants.js';
import { buildOrchestratorHarness, makeToolRegistryTools } from './testHarness.js';
import { createToolRegistry } from '../gateway/toolRegistry.js';
import type { WhatsAppInboundEvent } from '../tools/whatsappTool.js';

const RESIDENT_CONTEXT = { residentId: 'resident-1', whatsappThreadId: '919820011002' };

function complaintEvent(text: string): WhatsAppInboundEvent {
  return {
    type: 'text',
    messageId: 'wamid.complaint1',
    from: '919820011002',
    timestamp: new Date(),
    text,
  };
}

describe('Complaint Workflow (HLD Sec 11)', () => {
  it('full flow: resident complaint -> ticket created (DB) -> secretary notified -> resident gets the ticket id', async () => {
    const tools = makeToolRegistryTools({
      complaint: {
        createComplaint: vi.fn().mockResolvedValue({
          id: 'complaint-42',
          ticketId: 'TCK-2026-0042',
          status: 'open',
          flatNumber: 'A-403',
        }),
        getComplaintByTicketId: vi.fn().mockResolvedValue(null),
      },
    });
    const { orchestrator, deps } = buildOrchestratorHarness({
      toolRegistry: createToolRegistry(tools),
    });

    const start = Date.now();
    await orchestrator.handleResidentEvent(
      complaintEvent('Water leakage in A-403, bathroom ceiling is damp again.'),
      RESIDENT_CONTEXT,
    );
    const elapsedMs = Date.now() - start;

    // 1. Database: the complaint (and its ticket id) was created.
    expect(tools.complaint.createComplaint).toHaveBeenCalledWith({
      residentId: 'resident-1',
      description: expect.stringContaining('Water leakage'),
    });

    // 2. Secretary notified — over WhatsApp, with the ticket id and flat.
    expect(deps.toolRegistry.whatsapp.sendMessage).toHaveBeenCalledWith(
      '+919820099000', // testHarness's default secretaryNumber
      expect.stringMatching(/TCK-2026-0042/),
    );
    expect(deps.toolRegistry.whatsapp.sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('A-403'),
    );

    // 3. Resident receives the ticket id back, and it's recorded in
    // conversation history (memory/conversationStore.ts).
    expect(deps.toolRegistry.whatsapp.replyMessage).toHaveBeenCalledWith(
      complaintEvent('x').from,
      expect.stringContaining('TCK-2026-0042'),
      expect.any(String),
    );
    expect(deps.conversationStore.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        residentId: 'resident-1',
        senderType: 'ai',
        body: expect.stringContaining('TCK-2026-0042'),
      }),
    );

    // Filing a complaint is a single-round-trip resident interaction —
    // same <5s NFR (HLD Sec 17) as the FAQ path.
    expect(elapsedMs).toBeLessThanOrEqual(NFR_TARGETS.averageResponseSeconds * 1000);
  });

  it("status check: a different resident asking about someone else's ticket cannot see its status (ownership scoping still holds end-to-end)", async () => {
    const tools = makeToolRegistryTools({
      complaint: {
        createComplaint: vi.fn(),
        getComplaintByTicketId: vi.fn().mockResolvedValue({
          id: 'complaint-42',
          ticketId: 'TCK-2026-0042',
          residentId: 'the-actual-owner',
          category: 'plumbing',
          description: 'Water leakage in A-403',
          status: 'in_progress',
          createdAt: new Date('2026-01-05T10:00:00Z'),
          resolvedAt: null,
        }),
      },
    });
    const { orchestrator, deps } = buildOrchestratorHarness({
      toolRegistry: createToolRegistry(tools),
    });

    await orchestrator.handleResidentEvent(
      complaintEvent('status of TCK-2026-0042'),
      RESIDENT_CONTEXT,
    );

    expect(tools.complaint.createComplaint).not.toHaveBeenCalled();
    expect(deps.toolRegistry.whatsapp.replyMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("couldn't find"),
      expect.any(String),
    );
  });

  it("the filing resident, asking their own ticket's status afterward, gets the real status", async () => {
    const tools = makeToolRegistryTools({
      complaint: {
        createComplaint: vi.fn(),
        getComplaintByTicketId: vi.fn().mockResolvedValue({
          id: 'complaint-42',
          ticketId: 'TCK-2026-0042',
          residentId: 'resident-1', // matches RESIDENT_CONTEXT
          category: 'plumbing',
          description: 'Water leakage in A-403',
          status: 'resolved',
          createdAt: new Date('2026-01-05T10:00:00Z'),
          resolvedAt: new Date('2026-01-08T10:00:00Z'),
        }),
      },
    });
    const { orchestrator, deps } = buildOrchestratorHarness({
      toolRegistry: createToolRegistry(tools),
    });

    await orchestrator.handleResidentEvent(
      complaintEvent('status of TCK-2026-0042'),
      RESIDENT_CONTEXT,
    );

    expect(deps.toolRegistry.whatsapp.replyMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringMatching(/resolved/i),
      expect.any(String),
    );
  });

  it('the complaint is still recorded even if the secretary WhatsApp notification fails (resilience, HLD-implied)', async () => {
    const tools = makeToolRegistryTools({
      whatsapp: {
        receiveMessage: vi.fn(),
        sendMessage: vi.fn().mockRejectedValue(new Error('WhatsApp API temporarily unreachable')),
        replyMessage: vi.fn().mockResolvedValue({ messageId: 'wamid.out', to: 'x' }),
        broadcastMessage: vi.fn(),
        uploadImage: vi.fn(),
        uploadPDF: vi.fn(),
        downloadMedia: vi.fn(),
      },
      complaint: {
        createComplaint: vi.fn().mockResolvedValue({
          id: 'complaint-43',
          ticketId: 'TCK-2026-0043',
          status: 'open',
          flatNumber: 'B-204',
        }),
        getComplaintByTicketId: vi.fn().mockResolvedValue(null),
      },
    });
    const { orchestrator, deps } = buildOrchestratorHarness({
      toolRegistry: createToolRegistry(tools),
    });

    await expect(
      orchestrator.handleResidentEvent(
        complaintEvent('The lift is broken again.'),
        RESIDENT_CONTEXT,
      ),
    ).resolves.toBeUndefined();

    expect(tools.complaint.createComplaint).toHaveBeenCalled();
    expect(deps.toolRegistry.whatsapp.replyMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('TCK-2026-0043'),
      expect.any(String),
    );
  });
});
