import { describe, expect, it, vi } from 'vitest';
import {
  checkMandatoryEscalation,
  escalateForReason,
  escalateUnknownAnswer,
} from './escalation.js';

function makeEscalationModule(id = 'e1234567-aaaa-bbbb-cccc-000000000000') {
  return {
    escalate: vi.fn().mockImplementation((input: { reason: string }) =>
      Promise.resolve({
        escalationId: id,
        category: 'committee_decision',
        replyText: input.reason.startsWith('unknown_answer')
          ? `I couldn't find a confident answer to that in our records, so I've forwarded your question to the Secretary (ref: ${id.slice(0, 8)}).`
          : `This needs the Secretary's attention, so I've forwarded it to them directly (ref: ${id.slice(0, 8)}).`,
      }),
    ),
  };
}

const CONTEXT = { sourceType: 'query' as const, sourceId: 'session-1' };

describe('checkMandatoryEscalation', () => {
  it('creates an escalation and returns the outcome for a legal_issue-shaped message', async () => {
    const escalationModule = makeEscalationModule();

    const outcome = await checkMandatoryEscalation(
      'I am going to consult my lawyer about this.',
      CONTEXT,
      escalationModule,
    );

    expect(outcome).not.toBeNull();
    expect(outcome?.trigger).toBe('legal_issue');
    expect(outcome?.escalationId).toBe('e1234567-aaaa-bbbb-cccc-000000000000');
    expect(escalationModule.escalate).toHaveBeenCalledWith({
      sourceType: 'query',
      sourceId: 'session-1',
      reason: 'legal_issue: I am going to consult my lawyer about this.',
      message: 'I am going to consult my lawyer about this.',
    });
  });

  it('creates an escalation for a harassment-shaped message', async () => {
    const escalationModule = makeEscalationModule();

    const outcome = await checkMandatoryEscalation(
      'The security guard has been harassing me for weeks.',
      CONTEXT,
      escalationModule,
    );

    expect(outcome?.trigger).toBe('harassment');
    expect(escalationModule.escalate).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining('harassment:') }),
    );
  });

  it('returns null and creates nothing for an ordinary message', async () => {
    const escalationModule = makeEscalationModule();

    const outcome = await checkMandatoryEscalation(
      'What time does the gym open?',
      CONTEXT,
      escalationModule,
    );

    expect(outcome).toBeNull();
    expect(escalationModule.escalate).not.toHaveBeenCalled();
  });

  it('gives a generic "forwarded to the Secretary" reply, not the unknown_answer wording', async () => {
    const escalationModule = makeEscalationModule();

    const outcome = await checkMandatoryEscalation(
      'I want to file a police complaint.',
      CONTEXT,
      escalationModule,
    );

    expect(outcome?.replyText).toContain('forwarded it to them directly');
    expect(outcome?.replyText).not.toContain('confident answer');
  });

  it('passes the resident id through to the escalation module when the context carries one', async () => {
    const escalationModule = makeEscalationModule();

    await checkMandatoryEscalation(
      'I am going to consult my lawyer about this.',
      { ...CONTEXT, residentId: 'resident-1' },
      escalationModule,
    );

    expect(escalationModule.escalate).toHaveBeenCalledWith(
      expect.objectContaining({ residentId: 'resident-1' }),
    );
  });
});

describe('escalateUnknownAnswer', () => {
  it('always creates an escalation with the unknown_answer trigger', async () => {
    const escalationModule = makeEscalationModule();

    const outcome = await escalateUnknownAnswer(
      'What is the airspeed velocity of an unladen swallow?',
      CONTEXT,
      escalationModule,
    );

    expect(outcome.trigger).toBe('unknown_answer');
    expect(escalationModule.escalate).toHaveBeenCalledWith({
      sourceType: 'query',
      sourceId: 'session-1',
      reason: 'unknown_answer: What is the airspeed velocity of an unladen swallow?',
      message: 'What is the airspeed velocity of an unladen swallow?',
    });
  });

  it('uses the "couldn\'t find a confident answer" wording, distinct from other triggers', async () => {
    const escalationModule = makeEscalationModule();

    const outcome = await escalateUnknownAnswer(
      'Some obscure question.',
      CONTEXT,
      escalationModule,
    );

    expect(outcome.replyText).toContain("couldn't find a confident answer");
    expect(outcome.replyText).toContain('e1234567');
  });
});

describe('escalateForReason', () => {
  it('creates an escalation with the exact reason text given, no trigger prefix', async () => {
    const escalationModule = makeEscalationModule();

    const outcome = await escalateForReason(
      'Please announce the water shutdown to everyone.',
      CONTEXT,
      escalationModule,
    );

    expect(escalationModule.escalate).toHaveBeenCalledWith({
      sourceType: 'query',
      sourceId: 'session-1',
      reason: 'Please announce the water shutdown to everyone.',
      message: 'Please announce the water shutdown to everyone.',
    });
    expect(outcome.replyText).toContain('forwarded it to them directly');
  });
});
