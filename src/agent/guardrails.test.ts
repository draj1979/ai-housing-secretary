import { describe, expect, it, vi } from 'vitest';
import {
  assertNotForbidden,
  detectEscalationTrigger,
  detectForbiddenActionRequest,
  enforceForbiddenActionGuardrail,
  ForbiddenActionError,
} from './guardrails.js';
import { AI_FORBIDDEN_ACTIONS } from '../config/constants.js';

describe('assertNotForbidden', () => {
  it('throws ForbiddenActionError for every action in AI_FORBIDDEN_ACTIONS', () => {
    for (const action of AI_FORBIDDEN_ACTIONS) {
      expect(() => assertNotForbidden(action)).toThrow(ForbiddenActionError);
    }
  });

  it('no-ops for an action not in the forbidden list', () => {
    expect(() => assertNotForbidden('answer_faq')).not.toThrow();
    expect(() => assertNotForbidden('create_complaint')).not.toThrow();
  });

  it('includes the action name in the thrown error', () => {
    try {
      assertNotForbidden('remove_complaint');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenActionError);
      expect((err as ForbiddenActionError).action).toBe('remove_complaint');
      expect((err as Error).message).toContain('remove_complaint');
    }
  });
});

describe('detectEscalationTrigger', () => {
  it('detects legal_issue phrasing', () => {
    expect(detectEscalationTrigger('I am going to consult my lawyer about this.')).toBe(
      'legal_issue',
    );
    expect(detectEscalationTrigger('This will go to court if unresolved.')).toBe('legal_issue');
  });

  it('detects police_complaint phrasing', () => {
    expect(detectEscalationTrigger('I will file a police complaint.')).toBe('police_complaint');
    expect(detectEscalationTrigger('This is a cognizable offence, calling police.')).toBe(
      'police_complaint',
    );
  });

  it('detects harassment phrasing', () => {
    expect(detectEscalationTrigger('The security guard threatened me yesterday.')).toBe(
      'harassment',
    );
    expect(detectEscalationTrigger('I am being harassed by a neighbour.')).toBe('harassment');
  });

  it('detects financial_dispute phrasing', () => {
    expect(detectEscalationTrigger('I want a refund for the overcharged maintenance.')).toBe(
      'financial_dispute',
    );
    expect(detectEscalationTrigger('This looks like fraud in the accounts.')).toBe(
      'financial_dispute',
    );
  });

  it('returns null for ordinary messages', () => {
    expect(detectEscalationTrigger('What time does the gym open?')).toBeNull();
    expect(detectEscalationTrigger('Water leakage in A-403.')).toBeNull();
  });

  it('never returns unknown_answer (that is set by the orchestrator, not text-detected)', () => {
    // exhaustively try messages that shouldn't match any keyword pattern
    expect(detectEscalationTrigger('asdkjfh randomtext 12345')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(detectEscalationTrigger('I WILL SUE the society')).toBe('legal_issue');
  });
});

describe('detectForbiddenActionRequest', () => {
  it('detects a request to approve a refund', () => {
    expect(detectForbiddenActionRequest('Can you approve a refund for my overpayment?')).toBe(
      'approve_refund',
    );
    expect(detectForbiddenActionRequest('Please give me my money back.')).toBe('approve_refund');
  });

  it('detects a request to change the maintenance amount', () => {
    expect(detectForbiddenActionRequest('Can you reduce my maintenance amount?')).toBe(
      'change_maintenance_amount',
    );
    expect(detectForbiddenActionRequest('Please waive my maintenance charge this month.')).toBe(
      'change_maintenance_amount',
    );
  });

  it('detects a request to change resident information', () => {
    expect(detectForbiddenActionRequest('Please update my phone number to 9876543210.')).toBe(
      'change_resident_information',
    );
    expect(detectForbiddenActionRequest('Can you change my flat details on record?')).toBe(
      'change_resident_information',
    );
  });

  it('detects a request to create a committee decision', () => {
    expect(detectForbiddenActionRequest('Please pass a resolution banning bikes.')).toBe(
      'create_committee_decision',
    );
  });

  it('detects a request to remove/delete a complaint', () => {
    expect(detectForbiddenActionRequest('Please delete my complaint, it was a mistake.')).toBe(
      'remove_complaint',
    );
    expect(detectForbiddenActionRequest('Can you withdraw my ticket?')).toBe('remove_complaint');
  });

  it('detects a request for a financial decision', () => {
    expect(detectForbiddenActionRequest('Please approve the budget for the new gate.')).toBe(
      'make_financial_decision',
    );
  });

  it('returns null for ordinary messages that merely mention a topic without requesting the action', () => {
    expect(detectForbiddenActionRequest('The lift has been broken since yesterday.')).toBeNull();
    expect(detectForbiddenActionRequest('What are the clubhouse timings?')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(detectForbiddenActionRequest('I WANT A REFUND NOW')).toBe('approve_refund');
  });
});

describe('enforceForbiddenActionGuardrail', () => {
  it('writes an audit_logs entry and returns the blocked action for a refund request', async () => {
    const auditLog = { logForbiddenActionBlocked: vi.fn().mockResolvedValue(undefined) };

    const action = await enforceForbiddenActionGuardrail(
      'Please approve a refund for my double payment.',
      auditLog,
      { actorPhoneE164: '+919820011002', sourceId: 'session-1' },
    );

    expect(action).toBe('approve_refund');
    expect(auditLog.logForbiddenActionBlocked).toHaveBeenCalledTimes(1);
    expect(auditLog.logForbiddenActionBlocked).toHaveBeenCalledWith({
      action: 'approve_refund',
      text: 'Please approve a refund for my double payment.',
      actorPhoneE164: '+919820011002',
      sourceId: 'session-1',
    });
  });

  it('does not write an audit log and returns null for an ordinary message', async () => {
    const auditLog = { logForbiddenActionBlocked: vi.fn().mockResolvedValue(undefined) };

    const action = await enforceForbiddenActionGuardrail('What time does the gym open?', auditLog);

    expect(action).toBeNull();
    expect(auditLog.logForbiddenActionBlocked).not.toHaveBeenCalled();
  });

  it('logs the block even without optional context (actorPhoneE164/sourceId)', async () => {
    const auditLog = { logForbiddenActionBlocked: vi.fn().mockResolvedValue(undefined) };

    const action = await enforceForbiddenActionGuardrail('Please delete my complaint.', auditLog);

    expect(action).toBe('remove_complaint');
    expect(auditLog.logForbiddenActionBlocked).toHaveBeenCalledWith({
      action: 'remove_complaint',
      text: 'Please delete my complaint.',
    });
  });
});
