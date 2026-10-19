import { test } from 'node:test';
import assert from 'node:assert';
import { CATALOG, keysOf, sanitizeKeys, labelOf, STARTER_PROJECT_ROLES, STARTER_OFFICE_ROLES } from '../src/access/catalog.js';

test('catalog: every key unique, scoped, labelled', () => {
  const all = CATALOG.flatMap(a => a.permissions.map(p => p.key));
  assert.equal(new Set(all).size, all.length);
  assert.ok(keysOf('project').includes('note.view'));
  assert.ok(!keysOf('project').includes('module.create'));
  assert.ok(keysOf('office').includes('module.create'));
  assert.ok(!keysOf('project').includes('task.create'));
  assert.ok(keysOf('project', { includeInactive: true }).includes('task.create'));
  for (const k of all) assert.notEqual(labelOf(k), k);
});
test('checkedOn: laptop keys', () => {
  const laptop = CATALOG.flatMap(a => a.permissions).filter(p => p.checkedOn === 'laptop').map(p => p.key).sort();
  assert.deepEqual(laptop, ['note.copy.out', 'project.delete', 'project.make_solo']); // project.edit: office since UI parity D1
});
test('sanitizeKeys drops unknown, wrong-scope and duplicate keys', () => {
  assert.deepEqual(sanitizeKeys('project', ['note.view', 'note.view', 'ticket.close', 'office.member.add', 7]), ['note.view']);
  assert.deepEqual(sanitizeKeys('project', 'nope'), []);
});
test('starter roles hold only catalog keys; Owner = all project keys', () => {
  const owner = STARTER_PROJECT_ROLES.find(r => r.name === 'Owner')!;
  assert.deepEqual([...owner.keys].sort(), keysOf('project', { includeInactive: true }).sort());
  for (const r of STARTER_PROJECT_ROLES) assert.deepEqual(sanitizeKeys('project', r.keys), r.keys);
  for (const r of STARTER_OFFICE_ROLES) assert.deepEqual(sanitizeKeys('office', r.keys), r.keys);
});
