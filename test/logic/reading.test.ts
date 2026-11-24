import { describe, expect, it } from 'vitest';
import { readingStatus, readingTitle } from '../../src/client/lib/reading';

describe('placeholder rows for documents being read', () => {
  it('calls a camera’s file name a photo and keeps a real name', () => {
    for (const filename of [
      'IMG_1234.HEIC',
      'image.jpg',
      'PXL_20261124_153012345.jpg',
      'photo.png',
    ])
      expect(readingTitle({ filename, mime: 'image/jpeg' })).toBe('Photo');
    expect(readingTitle({ filename: 'walgreens receipt.jpg', mime: 'image/jpeg' })).toBe(
      'walgreens receipt.jpg',
    );
    expect(readingTitle({ filename: 'IMG_1234.pdf', mime: 'application/pdf' })).toBe(
      'IMG_1234.pdf',
    );
  });

  it('says reading, or when it will try again', () => {
    const now = Date.parse('2026-11-24T15:30:00Z');
    expect(readingStatus({ status: 'pending', next_attempt_at: null }, now).label).toBe('Reading…');
    expect(readingStatus({ status: 'processing', next_attempt_at: null }, now).label).toBe(
      'Reading…',
    );
    const later = readingStatus(
      { status: 'failed', next_attempt_at: '2026-11-24T15:42:00Z' },
      now,
      () => '3:42 PM',
    );
    expect(later).toEqual({
      label: 'Couldn’t read it yet · trying again at 3:42 PM',
      retrying: true,
    });
    expect(
      readingStatus({ status: 'failed', next_attempt_at: '2026-11-24T15:00:00Z' }, now).label,
    ).toBe('Couldn’t read it yet · trying again now');
  });
});
