import { describe, expect, it } from 'vitest';
import { detectIntent } from './intentRouter.js';

describe('detectIntent', () => {
  it('classifies complaint language', () => {
    expect(detectIntent('Water leakage in A-403 again, bathroom ceiling is damp.')).toBe(
      'complaint',
    );
    expect(detectIntent('The lift has stopped working since morning.')).toBe('complaint');
    expect(detectIntent('There is a problem with the gym equipment.')).toBe('complaint');
  });

  it('classifies suggestion language', () => {
    expect(detectIntent('It would be great if we had more visitor parking.')).toBe('suggestion');
    expect(detectIntent('I have a suggestion for the garden area.')).toBe('suggestion');
    expect(detectIntent('Just some feedback on the new gate timings.')).toBe('suggestion');
  });

  it('classifies broadcast requests', () => {
    expect(detectIntent('Can you announce the water shutdown to everyone?')).toBe('broadcast');
    expect(detectIntent('Please send a notice to all residents about parking.')).toBe('broadcast');
  });

  it('classifies urgent/emergency language as escalation', () => {
    expect(detectIntent('This is urgent, please respond immediately.')).toBe('escalation');
    expect(detectIntent('Emergency — need help right now.')).toBe('escalation');
  });

  it('falls back to faq for anything else', () => {
    expect(detectIntent('What are the clubhouse timings?')).toBe('faq');
    expect(detectIntent('When is the AGM this year?')).toBe('faq');
    expect(detectIntent('Hello')).toBe('faq');
  });

  it('is case-insensitive', () => {
    expect(detectIntent('URGENT please help')).toBe('escalation');
    expect(detectIntent('BROKEN geyser in my flat')).toBe('complaint');
  });

  it('checks patterns in priority order (complaint before suggestion)', () => {
    // contains both "problem with" (complaint) and "suggest" (suggestion) — complaint wins, checked first
    expect(detectIntent('I have a problem with this, and a suggestion too.')).toBe('complaint');
  });
});
