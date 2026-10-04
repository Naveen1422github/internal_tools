// file: courier/test/autostart.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { autostartPlan, installAutostart, removeAutostart, type AutostartContext, type Command } from '../src/autostart.js';

// Dry-run only: nothing here registers anything with the OS.
const win: AutostartContext = {
  platform: 'win32', nodePath: 'C:\\Program Files\\nodejs\\node.exe', binPath: 'C:\\tools\\R&D\\internal_tools\\courier\\dist\\bin.js',
  home: 'C:\\Users\\naveen', env: { SystemRoot: 'C:\\Windows', USERDOMAIN: 'LAPTOP1', USERNAME: 'naveen' },
  courierDir: 'C:\\Users\\naveen\\AppData\\Local\\collab\\courier', logPath: 'C:\\Users\\naveen\\AppData\\Local\\collab\\courier\\courier.log',
};

function recorder() {
  const ran: Command[] = [], wrote: Array<[string, Buffer]> = [], removed: string[] = [];
  return { ran, wrote, removed, deps: { run: (c: Command) => { ran.push(c); }, write: (p: string, b: Buffer) => { wrote.push([p, b]); }, remove: (p: string) => { removed.push(p); } } };
}

test('Windows: a Task Scheduler task from an XML definition, schtasks by full path', () => {
  const p = autostartPlan(win);
  assert.equal(p.kind, 'windows-task');
  assert.deepEqual(p.install, [{ file: 'C:\\Windows\\System32\\schtasks.exe', args: ['/Create', '/TN', 'CollabSync', '/XML', 'C:\\Users\\naveen\\AppData\\Local\\collab\\courier\\collab-sync-task.xml', '/F'] }]);
  assert.deepEqual(p.remove, [{ file: 'C:\\Windows\\System32\\schtasks.exe', args: ['/Delete', '/TN', 'CollabSync', '/F'] }]);
  const bytes = p.files[0].content;
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe], 'UTF-16LE with BOM');
  const text = bytes.subarray(2).toString('utf16le');
  assert.match(text, /<LogonTrigger>[\s\S]*<UserId>LAPTOP1\\naveen<\/UserId>/);
  assert.match(text, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(text, /<Command>C:\\Program Files\\nodejs\\node.exe<\/Command>/);
  assert.match(text, /<Arguments>&quot;C:\\tools\\R&amp;D\\internal_tools\\courier\\dist\\bin.js&quot; sync start<\/Arguments>/);
  assert.match(text, /\r\n/);
  assert.match(p.describe.join('\n'), /autostart off/);
  assert.match(p.describe.join('\n'), /without admin/);
});

test('Windows falls back to %windir% and C:\\Windows for System32', () => {
  assert.equal(autostartPlan({ ...win, env: { windir: 'D:\\WIN', USERNAME: 'n' } }).install[0].file, 'D:\\WIN\\System32\\schtasks.exe');
  assert.equal(autostartPlan({ ...win, env: { USERNAME: 'n' } }).install[0].file, 'C:\\Windows\\System32\\schtasks.exe');
});

test('macOS: a LaunchAgent plist; the file is the registration', () => {
  const p = autostartPlan({ ...win, platform: 'darwin', nodePath: '/opt/homebrew/bin/node', binPath: '/Users/n/it/courier/dist/bin.js', home: '/Users/n', env: {}, logPath: '/Users/n/l.log', uid: 501 });
  assert.equal(p.files[0].path, '/Users/n/Library/LaunchAgents/com.collab.sync.plist');
  const text = p.files[0].content.toString('utf8');
  assert.match(text, /<string>\/opt\/homebrew\/bin\/node<\/string>\s*<string>\/Users\/n\/it\/courier\/dist\/bin.js<\/string>\s*<string>sync<\/string>\s*<string>run<\/string>/);
  assert.match(text, /<key>RunAtLoad<\/key><true\/>/);
  assert.deepEqual(p.install, []);
  assert.deepEqual(p.remove, [{ file: '/bin/launchctl', args: ['bootout', 'gui/501/com.collab.sync'] }]);
});

test('Linux: a systemd user unit, quoted and %-escaped', () => {
  const p = autostartPlan({ ...win, platform: 'linux', nodePath: '/usr/bin/node', binPath: '/home/n/100% it/courier/dist/bin.js', home: '/home/n', env: {}, systemctl: '/usr/bin/systemctl' });
  assert.equal(p.files[0].path, '/home/n/.config/systemd/user/collab-sync.service');
  assert.match(p.files[0].content.toString('utf8'), /^ExecStart="\/usr\/bin\/node" "\/home\/n\/100%% it\/courier\/dist\/bin.js" sync run$/m);
  assert.deepEqual(p.install.map((c) => c.args), [['--user', 'daemon-reload'], ['--user', 'enable', 'collab-sync.service']]);
  assert.deepEqual(p.remove.map((c) => c.args), [['--user', 'disable', 'collab-sync.service']]);
  assert.deepEqual(p.afterRemove.map((c) => c.args), [['--user', 'daemon-reload']]);
  assert.equal(autostartPlan({ ...win, platform: 'linux', home: '/h', env: { XDG_CONFIG_HOME: '/cfg' } }).files[0].path, '/cfg/systemd/user/collab-sync.service');
});

test('install writes then runs; remove runs, deletes, and tolerates "already gone"', () => {
  const p = autostartPlan(win);
  const r = recorder();
  installAutostart(p, r.deps);
  assert.deepEqual(r.wrote.map(([path]) => path), [p.files[0].path]);
  assert.deepEqual(r.ran, p.install);
  const r2 = recorder();
  const notes = removeAutostart(p, { ...r2.deps, run: () => { throw new Error('ERROR: The system cannot find the file specified.'); } });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /already removed/);
  assert.deepEqual(r2.removed, [p.files[0].path]);
  assert.throws(() => installAutostart(p, { ...r.deps, run: () => { throw new Error('Access is denied.'); } }), /could not register start-at-login[\s\S]*Access is denied/);
});
