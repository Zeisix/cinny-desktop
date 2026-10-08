const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function connect() {
  let observed;
  let failure;
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
      observed = targets;
      const page = targets.find(target => target.type === 'page');
      if (page) return page;
    } catch (error) { failure = error.message; }
    await delay(1000);
  }
  throw new Error('Cinny WebView2 debugging target did not appear: '+JSON.stringify({observed, failure}));
}

async function inspect(binary, iteration) {
  const process = spawn(binary, [], {env: {...global.process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222',
  }, stdio: ['ignore', 'pipe', 'pipe']});
  process.stdout.on('data', data => console.log('Cinny stdout:', data.toString()));
  process.stderr.on('data', data => console.log('Cinny stderr:', data.toString()));
  process.on('exit', code => console.log('Cinny exit:', code));
  let socket;
  try {
    const target = await connect();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {socket.onopen = resolve; socket.onerror = reject;});
    const pending = new Map();
    let id = 0;
    const events = [];
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const {resolve, reject, timer} = pending.get(message.id);
        clearTimeout(timer); pending.delete(message.id);
        message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
      } else if (message.method) events.push(message);
    };
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => reject(new Error('CDP timeout: '+method)), 30000);
      pending.set(key, {resolve, reject, timer});
      socket.send(JSON.stringify({id:key, method, params}));
    });
    await command('Runtime.enable');
    await delay(3000);
    const evaluate = async expression => {
      const result = await command('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    // Read the state first; do not prime permission through a console workaround.
    const startup = await evaluate(`({className: window.Notification.name,
      permission: window.Notification.permission,
      tauri: !!window.__TAURI_INTERNALS__,
      ready: !!window.__tauriNotificationPermissionReady,
      cache: window.__tauriNotificationPermission,
      settings: JSON.parse(localStorage.getItem('settings') || '{}')})`);
    const bootstrap = await evaluate(`Promise.race([
      Promise.resolve(window.__tauriNotificationPermissionReady).then(() => ({settled:true,permission:Notification.permission})),
      new Promise(resolve => setTimeout(() => resolve({settled:false}), 5000))])`);
    const report = {iteration, startup, bootstrap, exceptions: events.filter(event => event.method === 'Runtime.exceptionThrown')};
    if (global.process.env.CINNY_PROBE_DIAGNOSE === '1') {
      report.nativePermission = await evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:notification|is_permission_granted').catch(error => ({error}))`);
      report.afterQuery = await evaluate(`({permission:Notification.permission,cache:window.__tauriNotificationPermission})`);
      report.afterRequest = await evaluate(`Notification.requestPermission().then(result=>({result,permission:Notification.permission})).catch(error=>({error}))`);
    }
    fs.writeFileSync(`windows-webview-${iteration}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (global.process.env.CINNY_PROBE_DIAGNOSE !== '1') {
      assert.equal(startup.className, 'TauriNotification');
      assert.equal(startup.permission, 'granted', 'Real WebView2 cold-launch permission not granted');
      assert.equal(bootstrap.settled, true);
      // A real constructor must reach the native IPC handler without requestPermission().
      const delivery = await evaluate(`(async()=>{
        const notification = new Notification('Cinny native regression test', {body:'Cold launch without console permission workaround',silent:true});
        await notification.ready;
        return {permission:Notification.permission,delivered:true};
      })()`);
      assert.equal(delivery.delivered, true);
    }
  } finally {
    socket?.close();
    process.kill();
    await delay(2000);
    // Ensure embedded WebView children from this test do not retain the debugging port.
    await new Promise(resolve => {
      const cleanup = spawn('taskkill', ['/F','/IM','cinny.exe','/T'], {stdio:'ignore'});
      cleanup.on('exit', resolve); cleanup.on('error', resolve);
    });
    await delay(2000);
  }
}

(async()=>{
  const binary = path.resolve(global.process.argv[2]);
  assert(fs.statSync(binary).size > 1000000);
  await inspect(binary, 'cold');
  await inspect(binary, 'restart');
})().catch(error => {console.error(error);global.process.exitCode = 1;});
