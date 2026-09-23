// Read real local sessions and quota into an isolated ledger, then capture each page.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-preview-'));
process.env.TOKENPULSE_DATA_DIR = path.join(temp, 'data');
app.setPath('userData', path.join(temp, 'electron'));
// 额度预测和历史折线图要靠采样历史，复制一份本机的过来（只复制采样，不带任何账号凭据）。
const realData = path.join(os.homedir(), '.tokenpulse');
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
for (const name of ['quota-history.json', 'quota-checked.json']) {
  if (fs.existsSync(path.join(realData, name))) fs.copyFileSync(path.join(realData, name), path.join(process.env.TOKENPULSE_DATA_DIR, name));
}
const output = path.resolve(__dirname, '../artifacts/ui');
fs.mkdirSync(output, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = setTimeout(() => { console.error('Preview timed out'); app.exit(1); }, 60000);
app.on('web-contents-created', (_, contents) => {
  contents.on('console-message', (_, level, message) => { if (level >= 2) console.error(message); });
  contents.on('did-finish-load', async () => {
    try {
      const window = BrowserWindow.fromWebContents(contents);
      window.show();
      const summary = await contents.executeJavaScript(`window.tokenpulse.refresh().then(s => ({ files:s.fileCount, tokens:s.totals.all.tokens, accounts:s.accounts.map(a=>a.kind) }))`);
      console.log('Real data:', JSON.stringify(summary));
      const capture = async (name, script) => {
        if (script) await contents.executeJavaScript(script);
        await pause(1800);
        contents.invalidate(); await pause(100);
        fs.writeFileSync(path.join(output, name + '.png'), (await contents.capturePage()).toPNG());
      };
      await contents.executeJavaScript("setThemeMode('light')");
      await capture('overview-light');
      // Claude 的两个窗口都在用，预测和容量卡片都有数；容量折线图在页面下方，单独截一张。
      await capture('quota-light', "document.querySelector('[data-page=quota]').click(); document.querySelector('#account-tabs [data-account=claude]').click()");
      await capture('capacity-light', "document.querySelector('.capacity-panel')?.scrollIntoView({ block: 'center' })");
      await capture('usage-light', "document.querySelector('[data-page=usage]').click()");
      await capture('overview-dark', "document.querySelector('[data-page=overview]').click(); setThemeMode('dark')");
      await capture('settings-light', "setThemeMode('light'); openSettings().then(() => document.activeElement?.blur())");
      await contents.executeJavaScript("closeModal('settings')");
      window.setSize(900, 650);
      await capture('compact-light', "setThemeMode('light')");
      console.log('Saved 7 real-data screenshots to artifacts/ui');
      clearTimeout(timeout); app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
  });
});
require('../build/main/index.js');
