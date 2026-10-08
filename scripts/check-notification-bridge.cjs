const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('src-tauri/src/lib.rs', 'utf8');
const script = source.match(/let init_script = r#"([\s\S]*?)"#/)[1];

async function scenario(granted, requested) {
  const calls = [];
  const navigator = {permissions: {query: async parameters => ({state: 'delegated', name: parameters.name})}};
  const window = {__TAURI_INTERNALS__: {invoke: async (command, args) => {
    calls.push({command, args});
    if (command.endsWith('is_permission_granted')) return granted;
    if (command.endsWith('request_permission')) return requested;
  }}};
  const context = vm.createContext({window, navigator, console});
  const plugin = fs.readFileSync('scripts/fixtures/notification-plugin-2.3.3.js', 'utf8').replace('__TEMPLATE_windows__', 'true');
  vm.runInContext(plugin, context);
  vm.runInContext(script.replace('__CINNY_NATIVE_NOTIFICATION_PERMISSION__', granted ? 'granted' : 'default'), context);
  assert.equal(window.Notification.permission, granted ? 'granted' : 'default', 'Permission must be available synchronously');
  await window.__tauriNotificationPermissionReady;
  return {window, navigator, calls};
}

(async () => {
  assert(source.includes('.plugin(tauri_plugin_notification::init())'));
  assert(source.includes('.initialization_script(init_script)'));
  assert(source.includes('app.notification().permission_state()?'));
  const rejections = [];
  process.on('unhandledRejection', error => rejections.push(error));
  const cap = JSON.parse(fs.readFileSync('src-tauri/capabilities/migrated.json'));
  assert(cap.permissions.includes('notification:default'));
  assert(cap.remote.urls.includes('http://localhost:44548'));
  const a = await scenario(false, 'granted');
  assert.equal(a.window.Notification.permission, 'default');
  const status = await a.navigator.permissions.query({name: 'notifications'});
  assert.equal(status.state, 'prompt');
  const findings = [];
  if (a.window.Notification.permission === 'prompt') findings.push('Notification.permission returns prompt instead of default before permission is granted.');
  let changes = 0;
  status.addEventListener('change', function() {changes++; assert.equal(this.state, 'granted');});
  assert.equal(await a.window.Notification.requestPermission(), 'granted');
  assert.equal(a.window.Notification.permission, 'granted');
  assert.equal(changes, 1);
  new a.window.Notification('Test title', {body: 'Test body', silent: true});
  const payload = a.calls.find(c => c.command.endsWith('|notify')).args.options;
  assert.equal(payload.title, 'Test title');
  assert.equal(payload.body, 'Test body');
  if (payload.silent !== true) findings.push('The bridge drops silent; native quiet/loud behavior requires a native platform test.');
  assert.equal((await a.navigator.permissions.query({name: 'microphone'})).state, 'delegated');
  const b = await scenario(false, 'denied');
  await b.navigator.permissions.query({name: 'notifications'});
  assert.equal(await b.window.Notification.requestPermission(), 'denied');
  assert.equal(b.window.Notification.permission, 'denied');
  const c = await scenario(true, 'granted');
  // A cold launch must work before visiting Settings or calling requestPermission.
  assert.equal(c.window.Notification.permission, 'granted');
  assert.equal(c.calls.filter(call => call.command.endsWith('is_permission_granted')).length, 0);
  assert(!c.calls.some(call => call.command.endsWith('request_permission')));
  if (c.window.Notification.permission === 'granted') {
    new c.window.Notification('Cold launch message', {body: 'No console workaround'});
  }
  assert(c.calls.some(call => call.command.endsWith('|notify')), 'Cold launch message was suppressed');
  const restarted = await scenario(true, 'granted');
  assert.equal(restarted.window.Notification.permission, 'granted', 'Permission was lost on restart');
  assert.equal((await c.navigator.permissions.query({name: 'notifications'})).state, 'granted');
  assert.equal(c.window.Notification.permission, 'granted');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rejections.length, 0, 'Upstream plugin bootstrap clashed with the bridge');
  console.log(JSON.stringify({date: new Date().toISOString(), tests: 'IPC routing and Cinny permission-state update passed with mocked Tauri IPC', nativeRuntimeTest: 'NOT RUN', findings}, null, 2));
})();
