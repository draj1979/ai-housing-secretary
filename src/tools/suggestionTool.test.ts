import { describe, expect, it } from 'vitest';
import { categorizeSuggestion } from './suggestionTool.js';

describe('categorizeSuggestion', () => {
  it('categorizes security-related suggestions', () => {
    expect(categorizeSuggestion('We need more CCTV cameras at the gate.')).toBe('security');
    expect(categorizeSuggestion('Please add a watchman at the back gate.')).toBe('security');
  });

  it('categorizes finance-related suggestions', () => {
    expect(categorizeSuggestion('The maintenance charge should be reviewed.')).toBe('finance');
    expect(categorizeSuggestion('Can we see the budget breakdown for this year?')).toBe('finance');
  });

  it('categorizes amenities-related suggestions', () => {
    expect(categorizeSuggestion('The garden needs more benches.')).toBe('amenities');
    expect(categorizeSuggestion('It would be nice to have a better gym.')).toBe('amenities');
  });

  it('falls back to maintenance for anything else', () => {
    expect(categorizeSuggestion('The lift makes a strange noise sometimes.')).toBe('maintenance');
    expect(categorizeSuggestion('General feedback about the society.')).toBe('maintenance');
  });

  it('is case-insensitive', () => {
    expect(categorizeSuggestion('MORE CCTV CAMERAS PLEASE')).toBe('security');
  });

  it('checks patterns in priority order (security before amenities)', () => {
    // contains both "camera" (security) and "clubhouse" (amenities) — security wins, checked first
    expect(categorizeSuggestion('Install a camera near the clubhouse entrance.')).toBe('security');
  });
});
