import { describe, expect, it } from 'vitest';
import { redactPhoneNumbers, REDACTED_PHONE_PLACEHOLDER } from './piiRedaction.js';

describe('redactPhoneNumbers', () => {
  it('redacts an E.164 Indian mobile number', () => {
    expect(redactPhoneNumbers('Call me at +919820011001 please.')).toBe(
      `Call me at ${REDACTED_PHONE_PLACEHOLDER} please.`,
    );
  });

  it('redacts a number with hyphens/spaces', () => {
    expect(redactPhoneNumbers('My number is 98200-11001.')).toBe(
      `My number is ${REDACTED_PHONE_PLACEHOLDER}.`,
    );
  });

  it('redacts multiple numbers in the same text', () => {
    const result = redactPhoneNumbers('Reach me at +919820011001 or +919820099001.');
    expect(result).toBe(
      `Reach me at ${REDACTED_PHONE_PLACEHOLDER} or ${REDACTED_PHONE_PLACEHOLDER}.`,
    );
  });

  it('leaves ordinary text with no phone numbers unchanged', () => {
    const text = 'What are the clubhouse timings on weekends?';
    expect(redactPhoneNumbers(text)).toBe(text);
  });

  it('does not redact a ticket id (shorter digit run than a phone number)', () => {
    expect(redactPhoneNumbers('status of TCK-2026-0001')).toBe('status of TCK-2026-0001');
  });

  it('does not redact a flat number', () => {
    expect(redactPhoneNumbers('I live in A-403')).toBe('I live in A-403');
  });
});
