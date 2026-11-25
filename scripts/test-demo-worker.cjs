const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-demo-test-'));
const workers = [];
const app = new EventEmitter();
const electron = { app, utilityProcess: { fork(_file, _args, { env }) {
  const worker = new EventEmitter();
  worker.root = path.dirname(env.TOKENPULSE_DATA_DIR);
  worker.postMessage = message => { worker.message = message; };
  worker.kill = () => {};
  workers.push(worker);
  return worker;
} } };

async function run() {
  const load = Module._load;
  const tmpdir = os.tmpdir;
  let demo;
  try {
    os.tmpdir = () => root;
    Module._load = function (id, ...args) { return id === 'electron' ? electron : load.call(this, id, ...args); };
    try { demo = require('../build/main/demo.js'); } finally { Module._load = load; }

    const first = demo.demoCall('snapshot');
    demo.endDemo();
    const second = demo.demoCall('snapshot');
    workers[0].emit('exit');
    assert.equal(await first, null);
    assert.equal(fs.existsSync(workers[1].root), true, 'the old worker did not delete its replacement’s data');
    workers[1].emit('message', { id: workers[1].message.id, result: 'second snapshot' });
    assert.equal(await second, 'second snapshot', 'the old worker did not settle its replacement’s request');

    const failed = demo.demoCall('snapshot');
    workers[1].emit('exit');
    await assert.rejects(failed, /演示进程已退出/);
    assert.deepEqual(fs.readdirSync(root), []);
    console.log('PASS restarting the demo isolates in-flight requests and temporary files');
  } finally {
    os.tmpdir = tmpdir;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
