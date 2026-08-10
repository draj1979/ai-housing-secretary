import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { processInboundWebhookPayload } from './inboundProcessor.js';
import type { AppendMessageInput } from '../memory/conversationStore.js';

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tools/__fixtures__/whatsapp',
);

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf-8'));
}

function makeConversationStore() {
  const appendMessage = vi.fn(async (input: AppendMessageInput) => ({
    id: 'msg-1',
    conversationId: 'conv-1',
    direction: input.direction,
    senderType: input.senderType,
    body: input.body,
    mediaUrl: input.mediaUrl ?? null,
    createdAt: new Date(),
  }));
  return { appendMessage };
}

describe('processInboundWebhookPayload', () => {
  it('persists a text message from a registered resident and calls onEvent', async () => {
    const conversationStore = makeConversationStore();
    const findResidentIdByPhone = vi.fn().mockResolvedValue('resident-1');
    const onEvent = vi.fn().mockResolvedValue(undefined);

    const result = await processInboundWebhookPayload(loadFixture('text-message.json'), {
      conversationStore,
      findResidentIdByPhone,
      onEvent,
    });

    expect(result).toEqual({ processed: 1, skippedUnregistered: 0, secretaryEvents: 0, total: 1 });
    expect(findResidentIdByPhone).toHaveBeenCalledWith('+919820011002');
    expect(conversationStore.appendMessage).toHaveBeenCalledWith({
      residentId: 'resident-1',
      whatsappThreadId: '919820011002',
      direction: 'in',
      senderType: 'resident',
      body: 'Water leakage in A-403 again, bathroom ceiling is damp.',
    });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'text' }), {
      residentId: 'resident-1',
      whatsappThreadId: '919820011002',
    });
  });

  it('skips (does not append) a message from an unregistered phone number, but does not throw', async () => {
    const conversationStore = makeConversationStore();
    const findResidentIdByPhone = vi.fn().mockResolvedValue(undefined);
    const onEvent = vi.fn().mockResolvedValue(undefined);
    const logger = { warn: vi.fn(), info: vi.fn() };

    const result = await processInboundWebhookPayload(loadFixture('text-message.json'), {
      conversationStore,
      findResidentIdByPhone,
      onEvent,
      // @ts-expect-error partial pino Logger stub is fine for this test
      logger,
    });

    expect(result).toEqual({ processed: 0, skippedUnregistered: 1, secretaryEvents: 0, total: 1 });
    expect(conversationStore.appendMessage).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('carries a resolvable media reference for image messages', async () => {
    const conversationStore = makeConversationStore();
    const findResidentIdByPhone = vi.fn().mockResolvedValue('resident-5');

    await processInboundWebhookPayload(loadFixture('image-message.json'), {
      conversationStore,
      findResidentIdByPhone,
    });

    expect(conversationStore.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: '[image] Broken clubhouse gate hinge',
        mediaUrl: 'whatsapp-media://1234567890123456',
      }),
    );
  });

  it('carries a resolvable media reference and filename for document messages', async () => {
    const conversationStore = makeConversationStore();
    const findResidentIdByPhone = vi.fn().mockResolvedValue('resident-3');

    await processInboundWebhookPayload(loadFixture('document-message.json'), {
      conversationStore,
      findResidentIdByPhone,
    });

    expect(conversationStore.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: '[document] leave-and-license-agreement.pdf Tenancy agreement for B-204',
        mediaUrl: 'whatsapp-media://9876543210654321',
      }),
    );
  });

  it('renders a reaction as readable conversation history', async () => {
    const conversationStore = makeConversationStore();
    const findResidentIdByPhone = vi.fn().mockResolvedValue('resident-2');

    await processInboundWebhookPayload(loadFixture('reaction-message.json'), {
      conversationStore,
      findResidentIdByPhone,
    });

    expect(conversationStore.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('👍'),
      }),
    );
  });

  it('processes nothing for a status-only payload', async () => {
    const conversationStore = makeConversationStore();
    const findResidentIdByPhone = vi.fn().mockResolvedValue('resident-1');

    const result = await processInboundWebhookPayload(loadFixture('status-update.json'), {
      conversationStore,
      findResidentIdByPhone,
    });

    expect(result).toEqual({ processed: 0, skippedUnregistered: 0, secretaryEvents: 0, total: 0 });
    expect(conversationStore.appendMessage).not.toHaveBeenCalled();
  });

  it('uses a default onEvent (logs) when none is provided, without throwing', async () => {
    const conversationStore = makeConversationStore();
    const findResidentIdByPhone = vi.fn().mockResolvedValue('resident-1');

    await expect(
      processInboundWebhookPayload(loadFixture('text-message.json'), {
        conversationStore,
        findResidentIdByPhone,
      }),
    ).resolves.toMatchObject({ processed: 1 });
  });

  describe('dual-number routing (HLD Sec 4)', () => {
    it('routes an event on the secretary number to onSecretaryEvent, skipping resident lookup and memory write', async () => {
      const conversationStore = makeConversationStore();
      const findResidentIdByPhone = vi.fn().mockResolvedValue('resident-1');
      const onEvent = vi.fn().mockResolvedValue(undefined);
      const onSecretaryEvent = vi.fn().mockResolvedValue(undefined);

      const result = await processInboundWebhookPayload(
        loadFixture('secretary-number-message.json'),
        {
          conversationStore,
          findResidentIdByPhone,
          onEvent,
          onSecretaryEvent,
          secretaryPhoneNumberId: '109876543210002',
        },
      );

      expect(result).toEqual({
        processed: 0,
        skippedUnregistered: 0,
        secretaryEvents: 1,
        total: 1,
      });
      expect(findResidentIdByPhone).not.toHaveBeenCalled();
      expect(conversationStore.appendMessage).not.toHaveBeenCalled();
      expect(onEvent).not.toHaveBeenCalled();
      expect(onSecretaryEvent).toHaveBeenCalledTimes(1);
      expect(onSecretaryEvent).toHaveBeenCalledWith(
        expect.objectContaining({ from: '919820099000' }),
      );
    });

    it('still routes to the resident path when secretaryPhoneNumberId does not match the event', async () => {
      const conversationStore = makeConversationStore();
      const findResidentIdByPhone = vi.fn().mockResolvedValue('resident-1');
      const onSecretaryEvent = vi.fn().mockResolvedValue(undefined);

      const result = await processInboundWebhookPayload(loadFixture('text-message.json'), {
        conversationStore,
        findResidentIdByPhone,
        onSecretaryEvent,
        secretaryPhoneNumberId: '109876543210002', // text-message.json arrived on 109876543210001
      });

      expect(result).toEqual({
        processed: 1,
        skippedUnregistered: 0,
        secretaryEvents: 0,
        total: 1,
      });
      expect(onSecretaryEvent).not.toHaveBeenCalled();
    });

    it('treats every event as resident-number when secretaryPhoneNumberId is not configured', async () => {
      const conversationStore = makeConversationStore();
      const findResidentIdByPhone = vi.fn().mockResolvedValue('resident-1');
      const onSecretaryEvent = vi.fn().mockResolvedValue(undefined);

      const result = await processInboundWebhookPayload(
        loadFixture('secretary-number-message.json'),
        {
          conversationStore,
          findResidentIdByPhone,
          onSecretaryEvent,
          // no secretaryPhoneNumberId
        },
      );

      expect(result.secretaryEvents).toBe(0);
      expect(onSecretaryEvent).not.toHaveBeenCalled();
      // falls through to resident lookup, using the (unregistered) secretary phone
      expect(findResidentIdByPhone).toHaveBeenCalledWith('+919820099000');
    });

    it('uses a default onSecretaryEvent (logs) when none is provided, without throwing', async () => {
      const conversationStore = makeConversationStore();
      const findResidentIdByPhone = vi.fn().mockResolvedValue('resident-1');

      await expect(
        processInboundWebhookPayload(loadFixture('secretary-number-message.json'), {
          conversationStore,
          findResidentIdByPhone,
          secretaryPhoneNumberId: '109876543210002',
        }),
      ).resolves.toMatchObject({ secretaryEvents: 1 });
    });
  });
});
