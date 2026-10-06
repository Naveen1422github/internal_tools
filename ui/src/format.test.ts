import { describe, it, expect } from 'vitest';
import { formatEntryRef, formatNoteRef, parseEntryRef, parseNoteRef } from './format';

describe('formatEntryRef', () => {
  it('pads to 5 digits with the E series by default', () => {
    expect(formatEntryRef(12)).toBe('E-00012');
    expect(formatEntryRef(123456)).toBe('E-123456');
  });
  it('a missing number prints E-?, never E-0null', () => {
    expect(formatEntryRef(null)).toBe('E-?');
    expect(formatEntryRef(undefined)).toBe('E-?');
  });
  it('a project series prints its bare number; only E is padded', () => {
    expect(formatEntryRef(7, 'ACME')).toBe('ACME-7');
    expect(formatEntryRef(12, 'SH')).toBe('SH-12');
    expect(formatEntryRef(12)).toBe('E-00012');
  });
});

describe('parseEntryRef (mirror of core)', () => {
  it('reads the same forms core does', () => {
    for (const v of ['214', '#214', 'E-214', 'e214', 'E-00214', ' 214 ']) expect(parseEntryRef(v)).toBe(214);
    for (const v of ['', 'abc', '0', '12abc', 'ACME-12', ' 214']) expect(parseEntryRef(v)).toBeNull();
  });
});

describe('parseNoteRef / formatNoteRef (mirror of core)', () => {
  it('reads every accepted form', () => {
    const ok: Array<[string, { series: string; id: number }]> = [
      ['760', { series: 'E', id: 760 }], ['#760', { series: 'E', id: 760 }], ['E760', { series: 'E', id: 760 }],
      ['E-760', { series: 'E', id: 760 }], ['e-00760', { series: 'E', id: 760 }], [' \tE-7 ', { series: 'E', id: 7 }],
      ['SH-12', { series: 'SH', id: 12 }], ['sh-0012', { series: 'SH', id: 12 }], ['AB12CD34-1', { series: 'AB12CD34', id: 1 }],
      ['E2-5', { series: 'E2', id: 5 }],
    ];
    for (const [v, want] of ok) {
      expect(parseNoteRef(v)).toEqual(want);
      expect(parseNoteRef(formatNoteRef(want))).toEqual(want);
    }
  });
  it('rejects everything else', () => {
    for (const v of ['', 'E-', 'SH12', 'S-1', '1SH-2', 'SH-0', 'ABCDEFGHI-1', 'SH-1x', 'SH--1', '0', '-1', 'E-SH-1']) {
      expect(parseNoteRef(v)).toBeNull();
    }
  });
  it('prints SH-12 and E-00760', () => {
    expect(formatNoteRef({ series: 'SH', id: 12 })).toBe('SH-12');
    expect(formatNoteRef({ series: 'E', id: 760 })).toBe('E-00760');
  });
});
