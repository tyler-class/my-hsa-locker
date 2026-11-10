import { describe, expect, it } from 'vitest';
import {
  matchPerson,
  matchProvider,
  newPersonName,
  normalizePatientName,
  providersLooselyEqual,
  suggestPerson,
  withAlias,
} from '../../src/shared/logic';

const FAMILY = ['Example'];
const people = [
  { id: 'sam', name: 'Sam Example', aliases: [] },
  { id: 'alex', name: 'Alex', aliases: ['Alexandra Example'] },
  { id: 'mia', name: 'Mia Example', aliases: [] },
];

describe('normalizePatientName (legacy rules)', () => {
  it.each([
    ['Example, Sam', 'Sam Example'],
    ['Sam Example', 'Sam Example'],
    ['Sam (spouse)', 'Sam'],
    ['Sam Example (patient)', 'Sam Example'],
    ['EXAMPLE, SAM', 'Sam Example'],
    ['Example', 'Example'],
    ['  Mia   Example ', 'Mia Example'],
    ['Smith, Jordan', 'Smith, Jordan'], // not a family name: left alone, like the legacy code
  ])('%s → %s', (raw, out) => expect(normalizePatientName(raw, FAMILY)).toBe(out));
});

describe('matchPerson', () => {
  it('matches names and aliases exactly', () => {
    expect(matchPerson('Sam Example', people, FAMILY)).toEqual({ id: 'sam', via: 'exact' });
    expect(matchPerson('EXAMPLE, SAM', people, FAMILY)).toEqual({ id: 'sam', via: 'exact' });
    expect(matchPerson('Alexandra Example', people, FAMILY)).toEqual({ id: 'alex', via: 'exact' });
  });
  it('collapses "Alex" and "Alex Example" through the family name', () => {
    expect(matchPerson('Alex Example', people, FAMILY)).toEqual({ id: 'alex', via: 'family_name' });
    expect(matchPerson('Mia', people, FAMILY)).toEqual({ id: 'mia', via: 'family_name' });
  });
  it('does not guess', () => {
    expect(matchPerson('Alex Smith', people, FAMILY)).toBeNull();
    expect(matchPerson('Jordan', people, FAMILY)).toBeNull();
    expect(matchPerson('', people, FAMILY)).toBeNull();
    const twins = [
      { id: 'a', name: 'Sam', aliases: [] },
      { id: 'b', name: 'Sam', aliases: [] },
    ];
    expect(matchPerson('Sam', twins, FAMILY)).toBeNull();
  });
});

describe('providers', () => {
  const providers = [
    { id: 'pt', name: 'Lakeside Physical Therapy', aliases: [] },
    { id: 'gs', name: 'Riverbend Surgical Suites LLC', aliases: ['RSS'] },
  ];
  it('matches exact names and aliases, ignoring punctuation and LLC', () => {
    expect(matchProvider('LAKESIDE PHYSICAL THERAPY', providers)).toEqual({
      kind: 'exact',
      id: 'pt',
    });
    expect(matchProvider('Riverbend Surgical Suites', providers)).toEqual({
      kind: 'exact',
      id: 'gs',
    });
    expect(matchProvider('rss', providers)).toEqual({ kind: 'exact', id: 'gs' });
  });
  it('only suggests truncated EOB names', () => {
    expect(matchProvider('Lakeside Physical Ther', providers)).toEqual({
      kind: 'suggestion',
      id: 'pt',
      reason: 'truncated',
    });
    expect(matchProvider('Riverbend Surgical Suit', providers)).toMatchObject({
      kind: 'suggestion',
      id: 'gs',
    });
  });
  it('suggests near-identical spellings and ignores strangers', () => {
    expect(matchProvider('Lakeside Physical Therapy.', providers).kind).toBe('exact');
    expect(matchProvider('Lakside Physical Therapy', providers)).toMatchObject({
      kind: 'suggestion',
      reason: 'similar',
    });
    expect(matchProvider('Downtown Dental', providers)).toEqual({ kind: 'none' });
  });
  it('loose equality for duplicate checks', () => {
    expect(providersLooselyEqual('Lakeside Physical Ther', 'Lakeside Physical Therapy')).toBe(true);
    expect(providersLooselyEqual('', '')).toBe(false);
  });
  it('adds aliases once', () => {
    expect(withAlias('Sam', ['Sammy'], 'sammy ')).toEqual(['Sammy']);
    expect(withAlias('Sam', [], 'Samuel')).toEqual(['Samuel']);
    expect(withAlias('Sam', [], 'SAM')).toEqual([]);
  });
});

describe('new people from printed names', () => {
  it('tidies a clear name: trimmed, spaces collapsed, ALL CAPS title-cased', () => {
    expect(newPersonName('  Jordan   Rivera ')).toBe('Jordan Rivera');
    expect(newPersonName('JORDAN RIVERA')).toBe('Jordan Rivera');
    expect(newPersonName("MARY-KATE O'NEIL")).toBe("Mary-Kate O'Neil");
    expect(newPersonName('Jordan Rivera (dependent)')).toBe('Jordan Rivera');
    expect(newPersonName('Rivera, Jordan', ['Rivera'])).toBe('Jordan Rivera');
    expect(newPersonName('Jo')).toBe('Jo');
  });

  it('skips anything that isn’t clearly a name', () => {
    for (const junk of [
      null,
      '',
      '   ',
      'J',
      'J.',
      'Patient 2',
      'Member 0012345',
      'Patient',
      'PATIENT NAME',
      'Guarantor',
      'Self',
      'Subscriber',
      'Member',
      'Insured',
      'Dependent',
      'N/A',
      'n/a',
      'Unknown',
    ])
      expect(newPersonName(junk), String(junk)).toBeNull();
  });

  it('suggests a close match instead of a new person', () => {
    const household = [
      ...people,
      { id: 'will', name: 'William Smith', aliases: [] },
      { id: 'jon', name: 'Jon Rivera', aliases: [] },
    ];
    const s = (raw: string) => suggestPerson(raw, household, FAMILY);
    expect(s('Wm. Smith')).toEqual({ id: 'will', reason: 'abbreviated' });
    expect(s('W Smith')).toEqual({ id: 'will', reason: 'abbreviated' });
    expect(s('Smith William')).toEqual({ id: 'will', reason: 'reordered' });
    expect(s('John Rivera')).toEqual({ id: 'jon', reason: 'similar' });
    // A lone first name shared with someone (two Sams would leave matchPerson unsure).
    expect(s('Sam')).toEqual({ id: 'sam', reason: 'first_name' });
    expect(s('Sam Jones')).toBeNull();
    expect(s('Wendy Smith')).toBeNull();
    expect(s('Jordan Lee')).toBeNull();
  });
});
