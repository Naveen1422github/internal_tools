import { describe, it, expect } from 'vitest';
import { formatEntryRef, parseEntryRef } from './format';

describe('formatEntryRef', () => {
  it('pads to 5 digits with the E series by default', () => {
    expect(formatEntryRef(12)).toBe('E-00012');
    expect(formatEntryRef(123456)).toBe('E-123456');
  });
  it('a missing number prints E-?, never E-0null', () => {
    expect(formatEntryRef(null)).toBe('E-?');
    expect(formatEntryRef(undefined)).toBe('E-?');
  });
  it('a series other than E is accepted (stage B)', () => {
    expect(formatEntryRef(7, 'ACME')).toBe('ACME-00007');
  });
});

describe('parseEntryRef (mirror of core)', () => {
  it('reads the same forms core does', () => {
    for (const v of ['214', '#214', 'E-214', 'e214', 'E-00214', ' 214 ']) expect(parseEntryRef(v)).toBe(214);
    for (const v of ['', 'abc', '0', '12abc', 'ACME-12', ' 214']) expect(parseEntryRef(v)).toBeNull();
  });
});
