const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getPageDebuggerUrl(port = 9222) {
  for (let i = 0; i < 30; i++) {
    try {
      const data = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/json`, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => resolve(body));
        }).on('error', reject);
      });
      const json = JSON.parse(data);
      // Look for page type
      const page = json.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        return page.webSocketDebuggerUrl;
      }
    } catch (e) {
      await sleep(200);
    }
  }
  throw new Error('Could not find page target in Chrome');
}

async function run() {
  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-test-profile-'));
  const mockHtmlPath = path.resolve(__dirname, 'mock-glkvm.html');
  const bgJsPath = path.resolve(__dirname, '../src/background.js');
  const bgContent = fs.readFileSync(bgJsPath, 'utf8');

  // Extract automateGlkvmActions function from background.js
  const fnMatch = bgContent.match(/async function automateGlkvmActions\([^\)]*\)[\s\S]*?\n\}/);
  if (!fnMatch) {
    throw new Error('Could not extract automateGlkvmActions from background.js');
  }
  const fnCode = fnMatch[0];

  console.log('Launching headless Chrome with clean profile...');
  const chrome = spawn('google-chrome', [
    '--headless=new',
    '--remote-debugging-port=9222',
    '--no-sandbox',
    '--disable-gpu',
    `--user-data-dir=${tmpProfile}`,
    `file://${mockHtmlPath}`
  ]);

  try {
    const wsUrl = await getPageDebuggerUrl(9222);
    console.log('Connected to mock GLKVM page via CDP:', wsUrl);

    const ws = new WebSocket(wsUrl);
    await new Promise((resolve) => ws.onopen = resolve);

    let id = 1;
    function sendCdp(method, params = {}) {
      return new Promise((resolve, reject) => {
        const reqId = id++;
        const onMessage = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.id === reqId) {
            ws.removeEventListener('message', onMessage);
            if (msg.error) reject(msg.error);
            else resolve(msg.result);
          }
        };
        ws.addEventListener('message', onMessage);
        ws.send(JSON.stringify({ id: reqId, method, params }));
      });
    }

    // Wait for DOM to settle
    await sleep(500);

    const testUrl = 'https://example.com/tested-glkvm-link?token=abc-123';
    console.log(`Executing automateGlkvmActions with test URL: ${testUrl}`);

    const evalResult = await sendCdp('Runtime.evaluate', {
      expression: `
        (${fnCode})('${testUrl}').then(res => JSON.stringify(res));
      `,
      awaitPromise: true,
      returnByValue: true
    });

    console.log('Evaluation result:', evalResult.result.value);
    const parsed = JSON.parse(evalResult.result.value);
    if (!parsed.success) {
      throw new Error('Automation failed: ' + parsed.error);
    }

    // Verify mock DOM state
    const verifyDom = await sendCdp('Runtime.evaluate', {
      expression: `
        JSON.stringify({
          logCount: logCount,
          lastTypedText: window.__lastTypedText,
          lastLogText: document.getElementById('log-list').firstElementChild?.textContent,
          screenStatus: document.getElementById('screen-status').textContent
        })
      `,
      returnByValue: true
    });

    const domState = JSON.parse(verifyDom.result.value);
    console.log('Mock DOM State after automation:', domState);

    const expectedText = testUrl + '\n';
    if (domState.logCount >= 1 && domState.lastTypedText === expectedText) {
      console.log('\n SUCCESS: Automation verified end-to-end!');
      console.log('   - Button "Ctrl-L + L" clicked');
      console.log('   - Textarea populated with copied URL + newline');
      console.log('   - Button "Paste To Remote Device" clicked');
      console.log('   - Target device received URL ending in newline');
    } else {
      throw new Error(`DOM verification failed! Expected lastTypedText to be "${expectedText}", got "${domState.lastTypedText}"`);
    }

    ws.close();
  } finally {
    chrome.kill();
    try {
      fs.rmSync(tmpProfile, { recursive: true, force: true });
    } catch {}
  }
}

run().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
