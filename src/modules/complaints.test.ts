import { describe, expect, it, vi } from 'vitest';
import { createComplaintModule, extractTicketId, type ComplaintModuleDeps } from './complaints.js';
import type { Complaint, ComplaintStatus } from '../tools/complaintTool.js';

function makeComplaint(overrides: Partial<Complaint> = {}): Complaint {
  return {
    id: 'complaint-1',
    ticketId: 'TCK-2026-0001',
    status: 'open',
    flatNumber: 'A-403',
    ...overrides,
  };
}

function makeStatus(overrides: Partial<ComplaintStatus> = {}): ComplaintStatus {
  return {
    id: 'complaint-1',
    ticketId: 'TCK-2026-0001',
    residentId: 'resident-1',
    category: 'general',
    description: 'Water leakage in A-403',
    status: 'open',
    createdAt: new Date('2026-01-05T10:00:00Z'),
    resolvedAt: null,
    ...overrides,
  };
}

function makeAuditLog() {
  return { logAction: vi.fn().mockResolvedValue(undefined) };
}

function makeDeps(overrides: Partial<ComplaintModuleDeps> = {}): ComplaintModuleDeps {
  return {
    complaintTool: {
      createComplaint: vi.fn().mockResolvedValue(makeComplaint()),
      getComplaintByTicketId: vi.fn().mockResolvedValue(null),
    },
    whatsapp: { sendMessage: vi.fn().mockResolvedValue({ messageId: 'wamid.out', to: 'x' }) },
    secretaryNumber: '+919820099000',
    auditLog: makeAuditLog(),
    ...overrides,
  };
}

function makeDepsWithoutSecretaryNumber(
  overrides: Partial<Omit<ComplaintModuleDeps, 'secretaryNumber'>> = {},
): ComplaintModuleDeps {
  return {
    complaintTool: {
      createComplaint: vi.fn().mockResolvedValue(makeComplaint()),
      getComplaintByTicketId: vi.fn().mockResolvedValue(null),
    },
    whatsapp: { sendMessage: vi.fn().mockResolvedValue({ messageId: 'wamid.out', to: 'x' }) },
    auditLog: makeAuditLog(),
    ...overrides,
  };
}

describe('extractTicketId', () => {
  it('extracts a ticket id from "status of" phrasing', () => {
    expect(extractTicketId('status of TCK-2026-0001')).toBe('TCK-2026-0001');
  });

  it('extracts a ticket id embedded in other text', () => {
    expect(extractTicketId('any update on TCK-2026-0042 please?')).toBe('TCK-2026-0042');
  });

  it('extracts a bare ticket id with no surrounding words', () => {
    expect(extractTicketId('TCK-2026-0001')).toBe('TCK-2026-0001');
  });

  it('normalizes a lowercase ticket id to uppercase', () => {
    expect(extractTicketId('status of tck-2026-0001')).toBe('TCK-2026-0001');
  });

  it('returns null when the text has no ticket id', () => {
    expect(extractTicketId('Water leakage in A-403')).toBeNull();
    expect(extractTicketId('What are the clubhouse timings?')).toBeNull();
  });

  it('does not match a malformed ticket-id-like string', () => {
    expect(extractTicketId('TCK-26-1')).toBeNull();
    expect(extractTicketId('TCK-2026-1')).toBeNull();
  });
});

describe('createComplaintModule > fileComplaint (create -> notify -> confirm)', () => {
  it('creates the complaint, notifies the secretary with the ticket id and flat, and confirms to the resident', async () => {
    const deps = makeDeps();
    const complaints = createComplaintModule(deps);

    const outcome = await complaints.fileComplaint({
      residentId: 'resident-1',
      description: 'Water leakage in A-403, bathroom ceiling is damp.',
    });

    // Created.
    expect(deps.complaintTool.createComplaint).toHaveBeenCalledWith({
      residentId: 'resident-1',
      description: 'Water leakage in A-403, bathroom ceiling is damp.',
    });

    // Notified — secretary gets the ticket id and flat number.
    expect(deps.whatsapp.sendMessage).toHaveBeenCalledWith(
      '+919820099000',
      expect.stringContaining('TCK-2026-0001'),
    );
    expect(deps.whatsapp.sendMessage).toHaveBeenCalledWith(
      '+919820099000',
      expect.stringContaining('A-403'),
    );

    // Confirmed — resident gets the ticket id back.
    expect(outcome.kind).toBe('filed');
    expect(outcome.complaint?.ticketId).toBe('TCK-2026-0001');
    expect(outcome.replyText).toContain('TCK-2026-0001');
  });

  it('passes an explicit category through when given', async () => {
    const deps = makeDeps();
    const complaints = createComplaintModule(deps);

    await complaints.fileComplaint({
      residentId: 'resident-1',
      description: 'Broken gate hinge',
      category: 'maintenance',
    });

    expect(deps.complaintTool.createComplaint).toHaveBeenCalledWith({
      residentId: 'resident-1',
      description: 'Broken gate hinge',
      category: 'maintenance',
    });
  });

  it('still confirms the ticket even when the secretary notification is not configured', async () => {
    const deps = makeDepsWithoutSecretaryNumber();
    const complaints = createComplaintModule(deps);

    const outcome = await complaints.fileComplaint({
      residentId: 'resident-1',
      description: 'Leak',
    });

    expect(deps.whatsapp.sendMessage).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('filed');
    expect(outcome.replyText).toContain('TCK-2026-0001');
  });

  it('still records and confirms the complaint even if the secretary notification send fails', async () => {
    const deps = makeDeps({
      whatsapp: { sendMessage: vi.fn().mockRejectedValue(new Error('WhatsApp unreachable')) },
    });
    const complaints = createComplaintModule(deps);

    const outcome = await complaints.fileComplaint({
      residentId: 'resident-1',
      description: 'Leak',
    });

    expect(outcome.kind).toBe('filed');
    expect(outcome.replyText).toContain('TCK-2026-0001');
  });
});

describe('createComplaintModule > checkStatus', () => {
  it('returns the current status for a ticket owned by the requesting resident', async () => {
    const deps = makeDeps({
      complaintTool: {
        createComplaint: vi.fn(),
        getComplaintByTicketId: vi.fn().mockResolvedValue(makeStatus({ status: 'in_progress' })),
      },
    });
    const complaints = createComplaintModule(deps);

    const outcome = await complaints.checkStatus('TCK-2026-0001', 'resident-1');

    expect(outcome.kind).toBe('status_found');
    expect(outcome.replyText).toContain('in progress');
    expect(outcome.replyText).toContain('TCK-2026-0001');
  });

  it('includes the resolution date when a ticket is resolved', async () => {
    const deps = makeDeps({
      complaintTool: {
        createComplaint: vi.fn(),
        getComplaintByTicketId: vi
          .fn()
          .mockResolvedValue(
            makeStatus({ status: 'resolved', resolvedAt: new Date('2026-01-10T00:00:00Z') }),
          ),
      },
    });
    const complaints = createComplaintModule(deps);

    const outcome = await complaints.checkStatus('TCK-2026-0001', 'resident-1');

    expect(outcome.replyText).toContain('resolved');
  });

  it('returns not_found for a ticket id that does not exist', async () => {
    const deps = makeDeps(); // default getComplaintByTicketId resolves null
    const complaints = createComplaintModule(deps);

    const outcome = await complaints.checkStatus('TCK-2026-9999', 'resident-1');

    expect(outcome.kind).toBe('status_not_found');
    expect(outcome.replyText).toContain("couldn't find");
  });

  it('returns not_found (not the real status) for a ticket that belongs to a different resident', async () => {
    const deps = makeDeps({
      complaintTool: {
        createComplaint: vi.fn(),
        getComplaintByTicketId: vi
          .fn()
          .mockResolvedValue(makeStatus({ residentId: 'resident-OTHER' })),
      },
    });
    const complaints = createComplaintModule(deps);

    const outcome = await complaints.checkStatus('TCK-2026-0001', 'resident-1');

    expect(outcome.kind).toBe('status_not_found');
    expect(outcome.status).toBeUndefined();
  });
});

describe('createComplaintModule > handleMessage (dispatch)', () => {
  it('routes a message containing a ticket id to checkStatus', async () => {
    const deps = makeDeps({
      complaintTool: {
        createComplaint: vi.fn(),
        getComplaintByTicketId: vi.fn().mockResolvedValue(makeStatus()),
      },
    });
    const complaints = createComplaintModule(deps);

    const outcome = await complaints.handleMessage('status of TCK-2026-0001', {
      residentId: 'resident-1',
    });

    expect(outcome.kind).toBe('status_found');
    expect(deps.complaintTool.createComplaint).not.toHaveBeenCalled();
  });

  it('routes a message without a ticket id to fileComplaint', async () => {
    const deps = makeDeps();
    const complaints = createComplaintModule(deps);

    const outcome = await complaints.handleMessage('Water leakage in A-403', {
      residentId: 'resident-1',
    });

    expect(outcome.kind).toBe('filed');
    expect(deps.complaintTool.getComplaintByTicketId).not.toHaveBeenCalled();
    expect(deps.complaintTool.createComplaint).toHaveBeenCalledWith({
      residentId: 'resident-1',
      description: 'Water leakage in A-403',
    });
  });
});
