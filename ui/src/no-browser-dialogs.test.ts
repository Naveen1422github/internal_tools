import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// UI parity D13: the web UI never uses the browser's alert, confirm or prompt.
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
});

describe('no browser dialogs', () => {
  it('no alert(, confirm( or prompt( call in ui/src outside tests', () => {
    const hits = walk(join(__dirname)).flatMap((f) => readFileSync(f, 'utf8').split(/\r?\n/)
      .map((l, i) => ({ f, i: i + 1, l }))
      .filter(({ l }) => /(^|[^\w.])((window|globalThis)\.)?(alert|confirm|prompt)\(/.test(l.replace(/\/\/.*$/, ''))));
    expect(hits.map((h) => `${h.f}:${h.i}: ${h.l.trim()}`)).toEqual([]);
  });
});
