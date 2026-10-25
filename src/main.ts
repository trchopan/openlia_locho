import './style.css';

const status = document.querySelector<HTMLElement>('#status')!;
const form = document.querySelector<HTMLFormElement>('#connect')!;
const ticket = document.querySelector<HTMLTextAreaElement>('#ticket')!;
const open = document.querySelector<HTMLAnchorElement>('#open')!;
const disconnect = document.querySelector<HTMLButtonElement>('#disconnect')!;
let worker: ServiceWorker;

async function command(type: string, data: Record<string, unknown> = {}) {
  const channel = new MessageChannel();
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => { channel.port1.close(); reject(new Error('workerTimeout')); }, 60_000);
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timer);
      channel.port1.close();
      if (data.ok) resolve(data);
      else reject(new Error(data.code ?? 'failed'));
    };
    worker.postMessage({ type, ...data }, [channel.port2]);
  });
}

function show(connected: boolean) {
  open.hidden = !connected;
  disconnect.disabled = !connected;
  // A different deployment requires explicit disconnect, never an implicit switch.
  form.hidden = connected;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = ticket.value.trim();
  ticket.value = '';
  const button = form.querySelector('button')!;
  button.disabled = true;
  status.textContent = 'Connecting and checking Workspace UI health…';
  try {
    const result = await command('connect', { ticket: text });
    show(true);
    connectedMessage(result.authRequired === true);
  } catch (error) {
    status.textContent = `Connection failed: ${safeCode(error)}. No request was replayed.`;
  } finally { button.disabled = false; }
});

disconnect.addEventListener('click', async () => {
  disconnect.disabled = true;
  try {
    await command('disconnect');
    show(false);
    status.textContent = 'Disconnected; in-memory credentials cleared. Close old workspace tabs before connecting again.';
  } catch { status.textContent = 'Disconnect could not be confirmed. Close every tab for this site and reconnect.'; }
});

function safeCode(error: unknown) {
  const value = error instanceof Error ? error.message : '';
  return /^[a-zA-Z]{1,40}$/.test(value) ? value : 'unavailable';
}

function connectedMessage(authRequired: boolean) {
  status.textContent = authRequired
    ? 'Connected. Open your deployment’s Workspace UI to sign in. Its session stays only in worker memory.'
    : 'Connected. This deployment has no application authentication; use caution.';
  open.textContent = 'Open deployed Workspace UI';
}

async function start() {
  if (!isSecureContext || !('serviceWorker' in navigator)) throw new Error('secureContextRequired');
  await navigator.serviceWorker.register('/__locho/sw.js', { type: 'module', scope: '/', updateViaCache: 'none' });
  const registration = await navigator.serviceWorker.ready;
  worker = registration.active!;
  // The reserved control navigation may have come from the static network path;
  // ask the existing active worker to claim it before allowing any private fetch.
  const result = await command('status');
  if (!navigator.serviceWorker.controller) await new Promise<void>((resolve, reject) => {
    const changed = () => { clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', changed); resolve(); };
    const timer = setTimeout(() => { navigator.serviceWorker.removeEventListener('controllerchange', changed); reject(new Error('workerControlTimeout')); }, 10_000);
    navigator.serviceWorker.addEventListener('controllerchange', changed);
    if (navigator.serviceWorker.controller) changed();
  });
  show(result.connected === true);
  form.querySelector('button')!.disabled = false;
  if (result.connected) connectedMessage(result.authRequired === true);
  else status.textContent = 'Ready. Paste a workspace-ui TCP ticket.';
}

start().catch((error) => { status.textContent = `Proxy unavailable: ${safeCode(error)}.`; });
