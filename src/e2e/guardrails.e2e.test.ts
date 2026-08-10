/**
 * e2e/guardrails.e2e.test.ts
 *
 * HLD Sec 16 (Phase 3.2) regression suite: every forbidden action, every
 * mandatory escalation trigger, and the boundary cases around them, all
 * re-tested here in one place so a future change to
 * `agent/guardrails.ts`'s patterns, `gateway/orchestrator.ts`'s ordering,
 * or `agent/escalation.ts`'s wiring can't silently weaken a safety
 * boundary without a test failing *somewhere obvious* — this file,
 * specifically, not scattered incidentally across other suites.
 *
 * Goes through the real `gateway/orchestrator.ts` `handleResidentEvent`
 * pipeline end to end (not `detectForbiddenActionRequest`/
 * `detectEscalationTrigger` in isolation — those already have their own
 * pure-function unit tests in agent/guardrails.test.ts) — the property
 * this suite exists to protect is "the *whole system* blocks/escalates
 * correctly and logs it", which only holds if the wiring is right too.
 *
 * Four kinds of case, per HLD Sec 16's own two lists ("AI cannot" /
 * "AI must escalate"):
 *   1. Every AI_FORBIDDEN_ACTIONS pattern, multiple phrasings each —
 *      blocked, logged to audit_logs, never reaches a tool or Gemini.
 *   2. Every text-pattern ESCALATION_TRIGGERS pattern (excluding
 *      unknown_answer, which is FAQ-confidence-driven, not text-pattern —
 *      covered by e2e/residentQuery.e2e.test.ts instead), multiple
 *      phrasings each — escalated, never answered directly.
 *   3. Precedence: a phrase matching *both* a forbidden action and an
 *      escalation trigger pattern (e.g. "refund") is blocked as the
 *      forbidden action, not merely escalated — the guardrail runs first
 *      in the orchestrator, on purpose (HLD Sec 16).
 *   4. Negative cases: ordinary complaint/suggestion/FAQ-shaped messages
 *      containing *related but non-triggering* words must not be blocked
 *      or escalated — a regression here would mean the patterns became
 *      too broad, not too narrow, which is just as much a break.
 */
import { describe, expect, it, vi } from 'vitest';
import { AI_FORBIDDEN_ACTIONS, ESCALATION_TRIGGERS } from '../config/constants.js';
import { buildOrchestratorHarness, makeToolRegistryTools } from './testHarness.js';
import { createToolRegistry } from '../gateway/toolRegistry.js';
import type { WhatsAppInboundEvent } from '../tools/whatsappTool.js';
import type { KnowledgeSearchResult } from '../tools/knowledgeSearchTool.js';

const RESIDENT_CONTEXT = { residentId: 'resident-1', whatsappThreadId: '919820011001' };

function residentEvent(text: string, messageId = 'wamid.guard'): WhatsAppInboundEvent {
  return { type: 'text', messageId, from: '919820011001', timestamp: new Date(), text };
}

/**
 * Runs `text` through the real orchestrator and returns everything a case
 * below needs to assert on. `knowledgeMatch`, if given, is returned by
 * every category's `knowledgeSearch.search` — for benign FAQ-shaped
 * negative cases, so they resolve as a normal grounded answer instead of
 * an `unknown_answer` escalation (a *different*, legitimate escalation
 * path this file isn't testing — see e2e/residentQuery.e2e.test.ts for
 * that one). Omit it for every guardrail-positive case, where the message
 * should never reach knowledge search at all.
 */
async function run(text: string, knowledgeMatch?: KnowledgeSearchResult) {
  const tools = knowledgeMatch
    ? makeToolRegistryTools({
        knowledgeSearch: { search: vi.fn().mockResolvedValue([knowledgeMatch]) },
      })
    : undefined;
  const { orchestrator, deps } = buildOrchestratorHarness(
    tools ? { toolRegistry: createToolRegistry(tools) } : {},
  );
  await orchestrator.handleResidentEvent(residentEvent(text), RESIDENT_CONTEXT);
  return deps;
}

// ---------------------------------------------------------------------------
// 1. Every AI_FORBIDDEN_ACTIONS pattern — HLD Sec 16 "AI cannot"
// ---------------------------------------------------------------------------

const FORBIDDEN_ACTION_PHRASES: Record<(typeof AI_FORBIDDEN_ACTIONS)[number], string[]> = {
  make_financial_decision: [
    'Please approve the budget for the new gate.',
    'Can you sanction the expense for repainting?',
    'Please authorize the payment to the contractor.',
  ],
  approve_refund: [
    'Please approve a refund of ₹5000 for my double maintenance payment.',
    'I want my money back for the damage.',
    'Can you reimburse me for the plumber I hired myself?',
  ],
  change_maintenance_amount: [
    'Please reduce my maintenance amount this month.',
    'Can you waive the maintenance charge for me?',
    'Please increase the maintenance fee for everyone.',
  ],
  change_resident_information: [
    'Can you update my phone number on file?',
    'Please change my flat details in the system.',
    'Can you correct my name in your records?',
  ],
  create_committee_decision: [
    'Please pass a committee decision on this.',
    'This should be a committee decision.',
    'The committee should decide on the new gym equipment.',
  ],
  remove_complaint: [
    'Can you delete my complaint from the system?',
    'Please remove my ticket, I no longer need it.',
    'Can you cancel my complaint TCK-2026-0001?',
  ],
};

describe('Guardrail regression: AI_FORBIDDEN_ACTIONS (HLD Sec 16, Phase 3.2)', () => {
  for (const [action, phrases] of Object.entries(FORBIDDEN_ACTION_PHRASES)) {
    describe(action, () => {
      for (const phrase of phrases) {
        it(`blocks "${phrase}" before any tool/Gemini call, and logs it to audit_logs`, async () => {
          const deps = await run(phrase);

          // Blocked: never generated, never handed to a tool that would act on it.
          expect(deps.geminiResponder.generateReply).not.toHaveBeenCalled();
          expect(deps.toolRegistry.complaint.createComplaint).not.toHaveBeenCalled();
          expect(deps.toolRegistry.suggestion.createSuggestion).not.toHaveBeenCalled();
          expect(deps.toolRegistry.knowledgeSearch.search).not.toHaveBeenCalled();

          // Logged before anything else happens (HLD Sec 15).
          expect(deps.auditLog.logForbiddenActionBlocked).toHaveBeenCalledWith(
            expect.objectContaining({ action, text: phrase, actorPhoneE164: '+919820011001' }),
          );

          // Refused plainly, and still escalated (blocked doesn't mean ignored).
          expect(deps.toolRegistry.whatsapp.replyMessage).toHaveBeenCalledWith(
            expect.any(String),
            expect.stringContaining('not able to'),
            expect.any(String),
          );
          expect(deps.toolRegistry.escalation.createEscalation).toHaveBeenCalled();
        });
      }
    });
  }

  it('covers all six AI_FORBIDDEN_ACTIONS with at least one phrase each — this table itself cannot silently shrink', () => {
    expect(Object.keys(FORBIDDEN_ACTION_PHRASES).sort()).toEqual([...AI_FORBIDDEN_ACTIONS].sort());
    for (const phrases of Object.values(FORBIDDEN_ACTION_PHRASES)) {
      expect(phrases.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Every text-pattern ESCALATION_TRIGGERS — HLD Sec 16 "AI must escalate"
// ---------------------------------------------------------------------------

const TEXT_PATTERN_TRIGGERS = ESCALATION_TRIGGERS.filter((t) => t !== 'unknown_answer');

const ESCALATION_TRIGGER_PHRASES: Record<(typeof TEXT_PATTERN_TRIGGERS)[number], string[]> = {
  legal_issue: [
    'I am going to consult my lawyer about this.',
    'My advocate says we should take this to court.',
    'I will sue the society if this continues.',
  ],
  police_complaint: [
    'I want to file a police complaint.',
    "I've contacted the police about this.",
    'This is a cognizable offence and I will report it.',
  ],
  harassment: [
    'The security guard has been harassing me for weeks.',
    "I'm being threatened by another resident.",
    'The watchman has been stalking my daughter.',
  ],
  financial_dispute: [
    'I think there has been embezzlement of society funds.',
    'The treasurer is misappropriating our money.',
    'There is money missing from the society account.',
  ],
};

describe('Guardrail regression: ESCALATION_TRIGGERS (HLD Sec 16, Phase 3.2)', () => {
  for (const [trigger, phrases] of Object.entries(ESCALATION_TRIGGER_PHRASES)) {
    describe(trigger, () => {
      for (const phrase of phrases) {
        it(`escalates "${phrase}" instead of answering directly, and never calls Gemini`, async () => {
          const deps = await run(phrase);

          expect(deps.geminiResponder.generateReply).not.toHaveBeenCalled();
          expect(deps.toolRegistry.knowledgeSearch.search).not.toHaveBeenCalled();
          expect(deps.toolRegistry.complaint.createComplaint).not.toHaveBeenCalled();
          expect(deps.toolRegistry.escalation.createEscalation).toHaveBeenCalledWith(
            expect.objectContaining({ reason: expect.stringContaining(trigger) }),
          );
          expect(deps.toolRegistry.whatsapp.replyMessage).toHaveBeenCalledWith(
            expect.any(String),
            expect.stringContaining('forwarded'),
            expect.any(String),
          );
        });
      }
    });
  }

  it('covers every text-pattern ESCALATION_TRIGGERS entry with at least one phrase each', () => {
    expect(Object.keys(ESCALATION_TRIGGER_PHRASES).sort()).toEqual(
      [...TEXT_PATTERN_TRIGGERS].sort(),
    );
    for (const phrases of Object.values(ESCALATION_TRIGGER_PHRASES)) {
      expect(phrases.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Precedence: forbidden-action check runs before escalation-trigger check
// ---------------------------------------------------------------------------

describe('Guardrail regression: forbidden-action vs escalation-trigger precedence', () => {
  it('"refund" matches both approve_refund (forbidden) and financial_dispute (escalation) patterns — the forbidden-action block wins, since it runs first', async () => {
    const deps = await run('Please refund my payment immediately.');

    expect(deps.auditLog.logForbiddenActionBlocked).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'approve_refund' }),
    );
    expect(deps.toolRegistry.whatsapp.replyMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('not able to'),
      expect.any(String),
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Negative cases — ordinary messages must not be blocked or escalated
// ---------------------------------------------------------------------------

describe('Guardrail regression: negative cases (no false positives)', () => {
  // FAQ-shaped messages need a knowledge match, or the *unrelated*
  // unknown_answer escalation path (agent/escalation.ts's confidence
  // gate — a legitimate mechanism, not a guardrail false positive; see
  // e2e/residentQuery.e2e.test.ts) would fire instead and make this
  // assertion meaningless either way.
  const knowledgeMatch: KnowledgeSearchResult = {
    documentTitle: 'Clubhouse Rules',
    excerpt: 'Open 9am-10pm daily.',
    score: 0.9,
    category: 'clubhouse_rules',
  };

  const benignMessages: Array<[message: string, needsKnowledgeMatch: boolean]> = [
    ['Water leakage in A-403, please send a plumber.', false], // complaint — mentions no forbidden/escalation phrasing
    ['It would be great if we had more visitor parking.', false], // suggestion
    ['What time does the clubhouse open?', true], // faq
    ['The lift is broken and making a strange noise.', false], // complaint, "strange" isn't "urgent"/"emergency"
    ['My neighbor recommended I raise this as feedback.', false], // suggestion — "recommend" isn't legal/financial
  ];

  for (const [message, needsKnowledgeMatch] of benignMessages) {
    it(`does not block or escalate: "${message}"`, async () => {
      const deps = await run(message, needsKnowledgeMatch ? knowledgeMatch : undefined);

      expect(deps.auditLog.logForbiddenActionBlocked).not.toHaveBeenCalled();
      expect(deps.toolRegistry.escalation.createEscalation).not.toHaveBeenCalled();
    });
  }

  it('a resident asking the AI to broadcast something is escalated, not answered or sent (residents can never trigger a broadcast, HLD Sec 16)', async () => {
    const deps = await run('Please announce the water shutdown to everyone.');

    expect(deps.toolRegistry.escalation.createEscalation).toHaveBeenCalled();
    expect(deps.toolRegistry.broadcast.draftAnnouncement).not.toHaveBeenCalled();
    expect(deps.toolRegistry.broadcast.approveAndSend).not.toHaveBeenCalled();
  });

  it('generic urgency language with no specific trigger pattern still escalates rather than being answered directly', async () => {
    const deps = await run('This is an emergency, please help urgently!');

    expect(deps.toolRegistry.escalation.createEscalation).toHaveBeenCalled();
    expect(deps.geminiResponder.generateReply).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. Cross-reference: unknown_answer (FAQ low-confidence) — not text-pattern
// ---------------------------------------------------------------------------

describe('Guardrail regression: unknown_answer trigger (cross-reference)', () => {
  it('is exercised by e2e/residentQuery.e2e.test.ts, not here — it is confidence-driven, not text-pattern-driven', () => {
    // Deliberately a no-op assertion, not a skip: this test's presence (and
    // its passing) is the pointer itself — grepping this file for
    // "unknown_answer" finds this note instead of concluding the trigger
    // has no regression coverage at all.
    expect(ESCALATION_TRIGGERS).toContain('unknown_answer');
  });
});

describe('Guardrail regression: sanity — the two source-of-truth lists this suite is built from', () => {
  it('AI_FORBIDDEN_ACTIONS has exactly six entries (HLD Sec 16)', () => {
    expect(AI_FORBIDDEN_ACTIONS).toHaveLength(6);
  });

  it('ESCALATION_TRIGGERS has exactly five entries (HLD Sec 16)', () => {
    expect(ESCALATION_TRIGGERS).toHaveLength(5);
  });
});
