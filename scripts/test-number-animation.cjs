const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../renderer/app.js'), 'utf8');
const start = source.indexOf('function countTo('), end = source.indexOf('/** 分段控件', start);
assert.ok(start >= 0 && end > start);
for (const [origin, target] of [[0, 100], [100, 0]]) {
  const callbacks = [], shown = new Map([['test', origin]]);
  const context = { shown, reducedMotion: { matches: false }, entering: () => true, performance: { now: () => 100 }, requestAnimationFrame: callback => callbacks.push(callback) };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  const node = { isConnected: true, textContent: '' }; context.countTo(node, 'test', target, value => String(Math.round(value)));
  callbacks.shift()(90); assert.equal(Number(node.textContent), origin, 'An earlier rAF timestamp must not extrapolate outside the start value');
  callbacks.shift()(850); assert.equal(Number(node.textContent), target);
}
console.log('PASS number animation clamps earlier frame timestamps for increasing and decreasing values');
