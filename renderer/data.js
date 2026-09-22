/* 与视图分离的筛选与统计：浏览器和 Node 回归测试共用同一实现。 */
(function (root) {
  const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'tokens', 'requests', 'costUsd'];
  const empty = () => Object.fromEntries(fields.map(key => [key, 0]));
  const add = (target, row) => { for (const key of fields) target[key] += Number(row[key]) || 0; return target; };
  function dayKey(at) {
    const d = new Date(at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function shift(day, n) {
    const [y, m, d] = day.split('-').map(Number);
    return dayKey(new Date(y, m - 1, d + n, 12));
  }
  function dayCount(from, to) {
    return Math.round((Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / 86400000) + 1;
  }
  function select(rows, from, to, source = 'all') {
    return rows.filter(row => row.day >= from && row.day <= to && (source === 'all' || row.source === source));
  }
  function sum(rows) { return rows.reduce(add, empty()); }
  function group(rows, keys) {
    const groups = new Map();
    for (const row of rows) {
      const key = JSON.stringify(keys.map(k => row[k]));
      const value = groups.get(key) || { ...empty(), ...Object.fromEntries(keys.map(k => [k, row[k]])), unpriced: 0 };
      add(value, row);
      if (row.priced === false) value.unpriced += row.requests;
      groups.set(key, value);
    }
    return [...groups.values()];
  }
  function analyze(rows, from, to, source = 'all') {
    const selected = select(rows, from, to, source);
    const n = dayCount(from, to);
    const previous = select(rows, shift(from, -n), shift(from, -1), source);
    const byDay = new Map(group(selected, ['day']).map(row => [row.day, row]));
    const daily = Array.from({ length: Math.max(0, Math.min(n, 366)) }, (_, i) => {
      const day = shift(from, i);
      return byDay.get(day) || { day, ...empty() };
    });
    return { selected, total: sum(selected), previous: sum(previous), daily,
      models: group(selected, ['model', 'source']), sources: group(selected, ['source']),
      activeDays: daily.filter(row => row.requests > 0).length,
      unpriced: selected.filter(row => row.priced === false).reduce((n, row) => n + row.requests, 0) };
  }
  function csv(rows) {
    const columns = [['day','日期'],['source','工具'],['model','模型'],['requests','请求数'],['input','输入 tokens（含缓存）'],['output','输出 tokens'],['cacheRead','缓存读取'],['cacheWrite','缓存写入'],['reasoning','推理 tokens（输出子集）'],['tokens','总 tokens'],['costUsd','参考费用 USD'],['priced','有定价依据']];
    const cell = value => {
      let text = String(value ?? '');
      if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text;
      return '"' + text.replaceAll('"', '""') + '"';
    };
    return [columns.map(([, label]) => cell(label)).join(','), ...rows.map(row => columns.map(([key]) => cell(row[key])).join(','))].join('\r\n');
  }
  const api = { dayKey, shift, dayCount, select, sum, group, analyze, csv };
  if (typeof module !== 'undefined') module.exports = api;
  else root.PulseData = api;
})(typeof window !== 'undefined' ? window : globalThis);
