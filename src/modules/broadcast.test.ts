import { describe, expect, it, vi } from 'vitest';
import {
  createBroadcastModule,
  createLanguageImprover,
  languageImproverConfigFromEnv,
  type BroadcastModuleDeps,
} from './broadcast.js';
import type { Env } from '../config/env.js';
import type { Announcement, AnnouncementDetail } from '../tools/broadcastTool.js';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    GEMINI_API_KEY: 'test-key',
    GEMINI_MODEL: 'gemini-test-model',
    ...overrides,
  } as Env;
}

describe('languageImproverConfigFromEnv', () => {
  it('builds a config from env', () => {
    expect(languageImproverConfigFromEnv(makeEnv())).toEqual({
      apiKey: 'test-key',
      model: 'gemini-test-model',
    });
  });

  it('throws when GEMINI_API_KEY is missing', () => {
    expect(() => languageImproverConfigFromEnv(makeEnv({ GEMINI_API_KEY: '' }))).toThrow(
      /GEMINI_API_KEY/,
    );
  });
});

describe('createLanguageImprover', () => {
  it('returns the improved text from classifyImpl', async () => {
    const improver = createLanguageImprover({
      apiKey: 'k',
      model: 'm',
      improveImpl: vi.fn().mockResolvedValue('  Improved announcement text.  '),
    });
    await expect(improver.improve('raw text')).resolves.toBe('Improved announcement text.');
  });

  it('falls back to the original text when the model returns nothing', async () => {
    const improver = createLanguageImprover({
      apiKey: 'k',
      model: 'm',
      improveImpl: vi.fn().mockResolvedValue('   '),
    });
    await expect(improver.improve('raw text')).resolves.toBe('raw text');
  });
});

function makeAnnouncement(overrides: Partial<Announcement> = {}): Announcement {
  return {
    id: 'a1234567-aaaa-bbbb-cccc-000000000000',
    status: 'pending_approval',
    body: 'x',
    ...overrides,
  };
}

function makeDetail(overrides: Partial<AnnouncementDetail> = {}): AnnouncementDetail {
  return {
    id: 'a1234567-aaaa-bbbb-cccc-000000000000',
    status: 'pending_approval',
    body: 'Improved body',
    author: '+919820099000',
    mediaUrls: [],
    scheduledAt: null,
    approvedBy: null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<BroadcastModuleDeps> = {}): BroadcastModuleDeps {
  return {
    languageImprover: { improve: vi.fn().mockImplementation((t: string) => Promise.resolve(t)) },
    broadcastTool: {
      draftAnnouncement: vi.fn().mockResolvedValue(makeAnnouncement()),
      getAnnouncement: vi.fn().mockResolvedValue(makeDetail()),
      approveAndSend: vi.fn().mockResolvedValue({
        announcement: makeAnnouncement({ status: 'broadcast' }),
        broadcast: { sent: [{ messageId: 'm1', to: '1' }], failed: [], durationMs: 50 },
        approvedBy: '+919820099000',
      }),
      markApprovedForSchedule: vi.fn().mockResolvedValue(makeAnnouncement({ status: 'approved' })),
      sendApprovedAnnouncement: vi.fn().mockResolvedValue({
        announcement: makeAnnouncement({ status: 'broadcast' }),
        broadcast: { sent: [{ messageId: 'm1', to: '1' }], failed: [], durationMs: 50 },
        approvedBy: '+919820099000',
      }),
    },
    whatsapp: {
      uploadImage: vi.fn().mockResolvedValue({ mediaId: 'media-img' }),
      uploadPDF: vi.fn().mockResolvedValue({ mediaId: 'media-doc' }),
    },
    auditLog: { logBroadcastSent: vi.fn().mockResolvedValue(undefined) },
    scheduler: { scheduleBroadcast: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

describe('createBroadcastModule.draftAnnouncement', () => {
  it('improves the text via Gemini, stores it, and returns a preview with the approve instruction', async () => {
    const languageImprover = {
      improve: vi.fn().mockResolvedValue('Nicely formatted announcement.'),
    };
    const broadcastTool = makeDeps().broadcastTool;
    const module = createBroadcastModule(makeDeps({ languageImprover, broadcastTool }));

    const outcome = await module.draftAnnouncement({
      author: '+919820099000',
      body: 'water tanker mon 7am',
    });

    expect(languageImprover.improve).toHaveBeenCalledWith('water tanker mon 7am');
    expect(broadcastTool.draftAnnouncement).toHaveBeenCalledWith({
      author: '+919820099000',
      body: 'Nicely formatted announcement.',
      mediaUrls: [],
    });
    expect(outcome.improvedByGemini).toBe(true);
    expect(outcome.replyText).toContain('approve');
    expect(outcome.replyText).toContain('AI-formatted preview');
  });

  it('falls back to the original text (and flags it) when Gemini fails, without losing the draft', async () => {
    const languageImprover = {
      improve: vi.fn().mockRejectedValue(new Error('Gemini unavailable')),
    };
    const module = createBroadcastModule(makeDeps({ languageImprover }));

    const outcome = await module.draftAnnouncement({
      author: '+919820099000',
      body: 'water tanker mon 7am',
    });

    expect(outcome.improvedByGemini).toBe(false);
    expect(outcome.announcement).toBeDefined();
  });

  it('uploads image and PDF attachments and stores them encoded in mediaUrls', async () => {
    const broadcastTool = makeDeps().broadcastTool;
    const whatsapp = makeDeps().whatsapp;
    const module = createBroadcastModule(makeDeps({ broadcastTool, whatsapp }));

    await module.draftAnnouncement({
      author: '+919820099000',
      body: 'AGM notice attached.',
      imageAttachments: [{ filePath: '/tmp/photo.jpg' }],
      pdfAttachments: [{ filePath: '/tmp/agenda.pdf', filename: 'agenda.pdf' }],
    });

    expect(whatsapp.uploadImage).toHaveBeenCalledWith({ filePath: '/tmp/photo.jpg' });
    expect(whatsapp.uploadPDF).toHaveBeenCalledWith({
      filePath: '/tmp/agenda.pdf',
      filename: 'agenda.pdf',
    });
    expect(broadcastTool.draftAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrls: ['image:media-img', 'document:media-doc:agenda.pdf'],
      }),
    );
  });

  it('includes an already-uploaded attachment without calling upload again', async () => {
    const broadcastTool = makeDeps().broadcastTool;
    const whatsapp = makeDeps().whatsapp;
    const module = createBroadcastModule(makeDeps({ broadcastTool, whatsapp }));

    await module.draftAnnouncement({
      author: '+919820099000',
      body: 'Forwarded flyer.',
      existingAttachments: [{ type: 'image', mediaId: 'inbound-media-1' }],
    });

    expect(whatsapp.uploadImage).not.toHaveBeenCalled();
    expect(broadcastTool.draftAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrls: ['image:inbound-media-1'] }),
    );
  });

  it('passes scheduledFor through and mentions it in the preview', async () => {
    const broadcastTool = makeDeps().broadcastTool;
    const module = createBroadcastModule(makeDeps({ broadcastTool }));
    const scheduledFor = new Date('2026-09-01T09:00:00Z');

    const outcome = await module.draftAnnouncement({
      author: '+919820099000',
      body: 'AGM next week.',
      scheduledFor,
    });

    expect(broadcastTool.draftAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledFor }),
    );
    expect(outcome.replyText).toContain(scheduledFor.toISOString());
  });
});

describe('createBroadcastModule.approveAnnouncement', () => {
  it('sends immediately when there is no schedule, and logs the broadcast', async () => {
    const auditLog = { logBroadcastSent: vi.fn().mockResolvedValue(undefined) };
    const module = createBroadcastModule(makeDeps({ auditLog }));

    const outcome = await module.approveAnnouncement({
      idPrefix: 'a1234567',
      approvedBy: '+919820099000',
    });

    expect(outcome.kind).toBe('sent');
    expect(outcome.recipientCount).toBe(1);
    expect(outcome.failedCount).toBe(0);
    expect(auditLog.logBroadcastSent).toHaveBeenCalledWith({
      approvedBy: '+919820099000',
      announcementId: 'a1234567-aaaa-bbbb-cccc-000000000000',
      recipientCount: 1,
      failedCount: 0,
    });
  });

  it('marks approved and schedules a delayed job instead of sending when scheduledFor is in the future', async () => {
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000);
    const broadcastTool = makeDeps({
      broadcastTool: {
        ...makeDeps().broadcastTool,
        getAnnouncement: vi.fn().mockResolvedValue(makeDetail({ scheduledAt })),
      },
    }).broadcastTool;
    const scheduler = { scheduleBroadcast: vi.fn().mockResolvedValue(undefined) };
    const auditLog = { logBroadcastSent: vi.fn().mockResolvedValue(undefined) };
    const module = createBroadcastModule(makeDeps({ broadcastTool, scheduler, auditLog }));

    const outcome = await module.approveAnnouncement({
      idPrefix: 'a1234567',
      approvedBy: '+919820099000',
    });

    expect(outcome.kind).toBe('scheduled');
    expect(broadcastTool.markApprovedForSchedule).toHaveBeenCalledWith('a1234567', '+919820099000');
    expect(scheduler.scheduleBroadcast).toHaveBeenCalledWith(
      'a1234567-aaaa-bbbb-cccc-000000000000',
      scheduledAt,
    );
    expect(broadcastTool.approveAndSend).not.toHaveBeenCalled();
    expect(auditLog.logBroadcastSent).not.toHaveBeenCalled();
  });

  it('sends immediately when the schedule has already passed', async () => {
    const pastSchedule = new Date(Date.now() - 60 * 60 * 1000);
    const broadcastTool = makeDeps({
      broadcastTool: {
        ...makeDeps().broadcastTool,
        getAnnouncement: vi.fn().mockResolvedValue(makeDetail({ scheduledAt: pastSchedule })),
      },
    }).broadcastTool;
    const module = createBroadcastModule(makeDeps({ broadcastTool }));

    const outcome = await module.approveAnnouncement({
      idPrefix: 'a1234567',
      approvedBy: '+919820099000',
    });

    expect(outcome.kind).toBe('sent');
    expect(broadcastTool.approveAndSend).toHaveBeenCalled();
  });

  it('throws when no announcement matches the prefix', async () => {
    const broadcastTool = makeDeps({
      broadcastTool: {
        ...makeDeps().broadcastTool,
        getAnnouncement: vi.fn().mockResolvedValue(null),
      },
    }).broadcastTool;
    const module = createBroadcastModule(makeDeps({ broadcastTool }));

    await expect(
      module.approveAnnouncement({ idPrefix: 'nope', approvedBy: '+919820099000' }),
    ).rejects.toThrow(/No announcement found/);
  });

  it('throws when the announcement is not pending approval', async () => {
    const broadcastTool = makeDeps({
      broadcastTool: {
        ...makeDeps().broadcastTool,
        getAnnouncement: vi.fn().mockResolvedValue(makeDetail({ status: 'broadcast' })),
      },
    }).broadcastTool;
    const module = createBroadcastModule(makeDeps({ broadcastTool }));

    await expect(
      module.approveAnnouncement({ idPrefix: 'a1234567', approvedBy: '+919820099000' }),
    ).rejects.toThrow(/not pending approval/);
  });
});

describe('createBroadcastModule.runScheduledBroadcast', () => {
  it('sends the approved announcement and logs the broadcast', async () => {
    const auditLog = { logBroadcastSent: vi.fn().mockResolvedValue(undefined) };
    const module = createBroadcastModule(makeDeps({ auditLog }));

    const result = await module.runScheduledBroadcast('a1234567-aaaa-bbbb-cccc-000000000000');

    expect(result.recipientCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(auditLog.logBroadcastSent).toHaveBeenCalledWith({
      approvedBy: '+919820099000',
      announcementId: 'a1234567-aaaa-bbbb-cccc-000000000000',
      recipientCount: 1,
      failedCount: 0,
    });
  });
});
