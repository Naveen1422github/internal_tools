// file: courier/test/paths.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { courierDir, courierFiles } from '../src/paths.js';

test('the courier folder per OS (never in a repo)', () => {
  assert.equal(courierDir({ LOCALAPPDATA: 'C:\\Users\\n\\AppData\\Local' }, 'win32', 'C:\\Users\\n'), 'C:\\Users\\n\\AppData\\Local\\collab\\courier');
  assert.equal(courierDir({}, 'darwin', '/Users/n'), '/Users/n/Library/Application Support/collab/courier');
  assert.equal(courierDir({}, 'linux', '/home/n'), '/home/n/.local/state/collab/courier');
  assert.equal(courierDir({ XDG_STATE_HOME: '/s' }, 'linux', '/home/n'), '/s/collab/courier');
  assert.equal(courierDir({ COLLAB_COURIER_DIR: '/c' }, 'win32', 'C:\\Users\\n'), '/c');
  assert.deepEqual(Object.keys(courierFiles('/x')), ['dir', 'config', 'pid', 'status', 'log']);
});
