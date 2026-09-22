// Read real local sessions and quota into an isolated ledger, then capture each page.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-preview-'));
process.env.TOKENPULSE_DATA_DIR = path.join(temp, 'data');
app.setPath('userData', path.join(temp, 'electron'));
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
        await pause(250);
        contents.invalidate(); await pause(100);
        fs.writeFileSync(path.join(output, name + '.png'), (await contents.capturePage()).toPNG());
      };
      await contents.executeJavaScript("if(document.documentElement.dataset.theme==='dark') document.getElementById('theme-toggle').click()");
      await capture('overview-light');
      await capture('quota-light', "document.querySelector('[data-page=quota]').click()");
      await capture('usage-light', "document.querySelector('[data-page=usage]').click()");
      await capture('overview-dark', "document.querySelector('[data-page=overview]').click(); document.getElementById('theme-toggle').click()");
      window.setSize(900, 650);
      await capture('compact-light', "document.getElementById('theme-toggle').click()");
      console.log('Saved 5 real-data screenshots to artifacts/ui');
      clearTimeout(timeout); app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
  });
});
require('../build/main/index.js');
