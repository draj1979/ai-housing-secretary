import { describe, expect, it, vi } from 'vitest';
import {
  categorizeEscalation,
  createEscalationModule,
  type EscalationModuleDeps,
} from './escalation.js';
import type { Escalation, OpenEscalation } from '../tools/escalationTool.js';

describe('categorizeEscalation', () => {
  it.each([
    ['legal_issue: I will consult my lawyer.', 'legal_matter'],
    ['police_complaint: I filed an FIR.', 'abuse'],
    ['harassment: the guard keeps threatening me.', 'abuse'],
    ['financial_dispute: this maintenance bill is wrong.', 'financial_dispute'],
    ['unknown_answer: what is the airspeed velocity of a swallow?', 'unknown_question'],
  ] as const)('categorizes a "%s"-prefixed reason as %s', (reason, expected) => {
    expect(categorizeEscalation(reason)).toBe(expected);
  });

  it.each([
    [
      'forbidden_action_request:make_financial_decision: please decide on the budget',
      'financial_dispute',
    ],
    ['forbidden_action_request:approve_refund: please refund me', 'financial_dispute'],
    ['forbidden_action_request:change_maintenance_amount: lower my fee', 'financial_dispute'],
    ['forbidden_action_request:change_resident_information: update my phone', 'committee_decision'],
    ['forbidden_action_request:create_committee_decision: decide this', 'committee_decision'],
    ['forbidden_action_request:remove_complaint: delete my ticket', 'committee_decision'],
  ] as const)('categorizes a forbidden-action-shaped reason "%s" as %s', (reason, expected) => {
    expect(categorizeEscalation(reason)).toBe(expected);
  });

  it('falls back to keyword matching when there is no recognized prefix', () => {
    expect(categorizeEscalation('I want to talk to a lawyer about this.')).toBe('legal_matter');
    expect(categorizeEscalation('This is harassment and I want it to stop.')).toBe('abuse');
    expect(categorizeEscalation('The refund amount is wrong.')).toBe('financial_dispute');
  });

  it('defaults to committee_decision when nothing matches', () => {
    expect(categorizeEscalation('Please announce the water shutdown to everyone.')).toBe(
      'committee_decision',
    );
  });
});

function makeEscalation(overrides: Partial<Escalation> = {}): Escalation {
  return {
    id: 'e1234567-aaaa-bbbb-cccc-000000000000',
    status: 'pending',
    category: 'committee_decision',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<EscalationModuleDeps> = {}): EscalationModuleDeps {
  return {
    escalationTool: {
      createEscalation: vi.fn().mockResolvedValue(makeEscalation()),
      acknowledgeEscalation: vi.fn().mockResolvedValue(makeEscalation({ status: 'acknowledged' })),
      listOpenEscalations: vi.fn().mockResolvedValue([]),
    },
    auditLog: { logAction: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

describe('createEscalationModule.escalate', () => {
  it('auto-categorizes the reason and forwards it, plus resident context, to the tool', async () => {
    const escalationTool = makeDeps().escalationTool;
    const module = createEscalationModule(makeDeps({ escalationTool }));

    const outcome = await module.escalate({
      reason: 'legal_issue: I will sue.',
      sourceType: 'query',
      sourceId: 'session-1',
      residentId: 'resident-1',
      message: 'I will sue.',
    });

    expect(escalationTool.createEscalation).toHaveBeenCalledWith({
      sourceType: 'query',
      sourceId: 'session-1',
      reason: 'legal_issue: I will sue.',
      category: 'legal_matter',
      residentId: 'resident-1',
      message: 'I will sue.',
    });
    expect(outcome.category).toBe('legal_matter');
    expect(outcome.replyText).toContain('forwarded it to them directly');
  });

  it('uses the unknown-answer wording specifically for unknown_question', async () => {
    const module = createEscalationModule(makeDeps());

    const outcome = await module.escalate({
      reason: 'unknown_answer: some obscure question',
      sourceType: 'query',
      sourceId: 'session-1',
    });

    expect(outcome.category).toBe('unknown_question');
    expect(outcome.replyText).toContain("couldn't find a confident answer");
  });

  it('respects an explicit category override instead of auto-categorizing', async () => {
    const escalationTool = makeDeps().escalationTool;
    const module = createEscalationModule(makeDeps({ escalationTool }));

    await module.escalate({
      reason: 'Please announce the water shutdown to everyone.',
      sourceType: 'query',
      sourceId: 'session-1',
      category: 'financial_dispute',
    });

    expect(escalationTool.createEscalation).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'financial_dispute' }),
    );
  });

  it('auto-links a ticket id found in the message text', async () => {
    const escalationTool = makeDeps().escalationTool;
    const module = createEscalationModule(makeDeps({ escalationTool }));

    await module.escalate({
      reason: 'legal_issue: regarding TCK-2026-0001, I will sue if not fixed.',
      sourceType: 'query',
      sourceId: 'session-1',
      message: 'regarding TCK-2026-0001, I will sue if not fixed.',
    });

    expect(escalationTool.createEscalation).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: 'TCK-2026-0001' }),
    );
  });

  it('does not include a ticketId when none is found and none was given', async () => {
    const escalationTool = makeDeps().escalationTool;
    const module = createEscalationModule(makeDeps({ escalationTool }));

    await module.escalate({
      reason: 'legal_issue: I will sue.',
      sourceType: 'query',
      sourceId: 'session-1',
      message: 'I will sue.',
    });

    const call = (escalationTool.createEscalation as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.ticketId).toBeUndefined();
  });
});

describe('createEscalationModule.acknowledge', () => {
  it('delegates to the tool and formats the reply', async () => {
    const escalationTool = {
      ...makeDeps().escalationTool,
      acknowledgeEscalation: vi.fn().mockResolvedValue(makeEscalation({ status: 'resolved' })),
    };
    const module = createEscalationModule(makeDeps({ escalationTool }));

    const outcome = await module.acknowledge('e1234567', 'resolved');

    expect(escalationTool.acknowledgeEscalation).toHaveBeenCalledWith('e1234567', 'resolved');
    expect(outcome.replyText).toContain('resolved');
  });
});

describe('createEscalationModule.listOpenEscalations', () => {
  it('formats a non-empty list with refs and categories', async () => {
    const rows: OpenEscalation[] = [
      {
        id: 'e1234567-aaaa-bbbb-cccc-000000000000',
        category: 'legal_matter',
        status: 'pending',
        sourceType: 'query',
        reason: 'legal_issue: I will sue.',
        createdAt: new Date(),
      },
    ];
    const escalationTool = {
      ...makeDeps().escalationTool,
      listOpenEscalations: vi.fn().mockResolvedValue(rows),
    };
    const module = createEscalationModule(makeDeps({ escalationTool }));

    const outcome = await module.listOpenEscalations();

    expect(outcome.escalations).toEqual(rows);
    expect(outcome.replyText).toContain('e1234567');
    expect(outcome.replyText).toContain('legal_matter');
    expect(outcome.replyText).toContain('1 open escalation');
  });

  it('reports no pending escalations when the list is empty', async () => {
    const module = createEscalationModule(makeDeps());

    const outcome = await module.listOpenEscalations();

    expect(outcome.replyText).toBe('No pending escalations.');
    expect(outcome.escalations).toEqual([]);
  });
});
