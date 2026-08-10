/**
 * gateway/inboundProcessor.ts
 *
 * The actual "hand inbound WhatsApp events to the OpenClaw Gateway for
 * processing" step from the webhook (HLD Sec 4, 8: Webhook -> OpenClaw
 * Gateway -> Intent Detection -> ...). Runs off the BullMQ queue
 * (gateway/inboundWorker.ts), not inline in the HTTP request, so the
 * webhook can respond immediately (<5s NFR, HLD Sec 17).
 *
 * Dual-number routing (HLD Sec 4): each event's `toPhoneNumberId`
 * (tools/whatsappTool.ts, from the webhook's `metadata.phone_number_id`) is
 * checked against `secretaryPhoneNumberId`. Events on the Secretary's
 * private number skip resident lookup and conversation-memory writes
 * entirely and go straight to `onSecretaryEvent` — see
 * gateway/orchestrator.ts's module doc comment for why (the
 * `conversations` table is resident-scoped; the secretary isn't a
 * resident). Everything else is the public AI Secretary number's path:
 * normalize -> resolve resident -> persist to
 * memory/conversationStore.ts -> `onEvent` (gateway/orchestrator.ts's
 * `handleResidentEvent`, once wired up by gateway/inboundWorker.ts).
 */
import type { Logger } from 'pino';
import { receiveMessage, type WhatsAppInboundEvent } from '../tools/whatsappTool.js';
import type { AppendMessageInput, ConversationStore } from '../memory/conversationStore.js';

export interface InboundEventContext {
  residentId: string;
  whatsappThreadId: string;
}

export type InboundEventHandler = (
  event: WhatsAppInboundEvent,
  context: InboundEventContext,
) => Promise<void>;

export type SecretaryEventHandler = (event: WhatsAppInboundEvent) => Promise<void>;

export interface InboundProcessorDeps {
  conversationStore: Pick<ConversationStore, 'appendMessage'>;
  /** Looks up a resident's id by their E.164 phone number; `undefined` if unregistered. */
  findResidentIdByPhone: (phoneE164: string) => Promise<string | undefined>;
  logger?: Logger;
  /**
   * Called once per successfully-persisted resident-number event — the
   * seam gateway/inboundWorker.ts plugs gateway/orchestrator.ts's
   * `handleResidentEvent` into. Defaults to logging a TODO note.
   */
  onEvent?: InboundEventHandler;
  /**
   * The Human Secretary number's `phone_number_id` (config/env.ts
   * WHATSAPP_SECRETARY_PHONE_NUMBER_ID). Omit to treat every event as a
   * resident-number event (e.g. in tests, or if the secretary number isn't
   * configured yet).
   */
  secretaryPhoneNumberId?: string;
  /**
   * Called for events that arrived on the Secretary's number — the seam
   * gateway/inboundWorker.ts plugs `handleSecretaryEvent` into. Defaults to
   * logging a TODO note. Never receives resident-number events.
   */
  onSecretaryEvent?: SecretaryEventHandler;
}

export interface ProcessInboundResult {
  /** Resident-number events successfully written to conversation memory and handed to `onEvent`. */
  processed: number;
  /** Resident-number events from a phone with no matching `residents` row — logged, not persisted. */
  skippedUnregistered: number;
  /** Events routed to the secretary-number path (`onSecretaryEvent`). */
  secretaryEvents: number;
  total: number;
}

/** WhatsApp's webhook `from` is digits-only, no leading "+"; residents.phone_e164 stores E.164 with one. */
function toE164(waId: string): string {
  return waId.startsWith('+') ? waId : `+${waId}`;
}

/** Renders any inbound event as readable conversation-history text, even non-text message types. */
function eventToBody(event: WhatsAppInboundEvent): string {
  switch (event.type) {
    case 'text':
      return event.text;
    case 'image':
      return event.caption ? `[image] ${event.caption}` : '[image]';
    case 'document':
      return ['[document]', event.filename, event.caption]
        .filter((part): part is string => Boolean(part))
        .join(' ');
    case 'reaction':
      return `[reacted ${event.emoji} to message ${event.reactedToMessageId}]`;
    case 'unsupported':
      return `[unsupported message type: ${event.rawType}]`;
  }
}

async function defaultOnEvent(
  event: WhatsAppInboundEvent,
  context: InboundEventContext,
  logger?: Logger,
): Promise<void> {
  logger?.info(
    { eventType: event.type, whatsappThreadId: context.whatsappThreadId },
    'Inbound event persisted to conversation memory; no onEvent handler wired up.',
  );
}

async function defaultOnSecretaryEvent(
  event: WhatsAppInboundEvent,
  logger?: Logger,
): Promise<void> {
  logger?.info(
    { eventType: event.type, from: event.from },
    'Secretary-number event received; no onSecretaryEvent handler wired up.',
  );
}

/**
 * Normalizes a raw webhook payload and routes each event by which WhatsApp
 * number it arrived on (see module doc comment). Resident-number events
 * from an unregistered phone are logged and skipped rather than dropped
 * silently or thrown on — deciding what to do about an unknown sender
 * (e.g. auto-reply, escalate) belongs to a future module, not this layer.
 */
export async function processInboundWebhookPayload(
  payload: unknown,
  deps: InboundProcessorDeps,
): Promise<ProcessInboundResult> {
  const events = receiveMessage(payload);
  const onEvent = deps.onEvent ?? ((event, context) => defaultOnEvent(event, context, deps.logger));
  const onSecretaryEvent =
    deps.onSecretaryEvent ?? ((event) => defaultOnSecretaryEvent(event, deps.logger));

  let processed = 0;
  let skippedUnregistered = 0;
  let secretaryEvents = 0;

  for (const event of events) {
    if (deps.secretaryPhoneNumberId && event.toPhoneNumberId === deps.secretaryPhoneNumberId) {
      await onSecretaryEvent(event);
      secretaryEvents++;
      continue;
    }

    const phoneE164 = toE164(event.from);
    const residentId = await deps.findResidentIdByPhone(phoneE164);

    if (!residentId) {
      deps.logger?.warn(
        { from: event.from },
        'Inbound WhatsApp message from an unregistered phone number; skipping memory write.',
      );
      skippedUnregistered++;
      continue;
    }

    const whatsappThreadId = event.from;
    const appendInput: AppendMessageInput = {
      residentId,
      whatsappThreadId,
      direction: 'in',
      senderType: 'resident',
      body: eventToBody(event),
      // A resolvable reference, not a fetched copy — actually downloading
      // the bytes (via whatsappTool.downloadMedia) is a tool/module
      // decision, not the memory layer's.
      ...(event.type === 'image' || event.type === 'document'
        ? { mediaUrl: `whatsapp-media://${event.mediaId}` }
        : {}),
    };
    await deps.conversationStore.appendMessage(appendInput);
    await onEvent(event, { residentId, whatsappThreadId });
    processed++;
  }

  return { processed, skippedUnregistered, secretaryEvents, total: events.length };
}
