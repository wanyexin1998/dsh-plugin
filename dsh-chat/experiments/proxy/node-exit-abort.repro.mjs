// scratch 4: which teardown call + which client causes the abort?
import http from 'node:http';

const mode = process.argv[2];
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end('{"ok":true}'); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}/`;

if (mode.startsWith('fetch')) {
  await fetch(url);
  await fetch(url);
} else {
  const agent = new http.Agent({ keepAlive: true });
  for (let i = 0; i < 2; i++) {
    await new Promise((res, rej) => {
      const r = http.request(url, { agent }, (x) => { x.resume(); x.on('end', res); });
      r.on('error', rej);
      r.end();
    });
  }
}

const closed = new Promise((r) => srv.close(r));
if (mode.endsWith('closeall')) srv.closeAllConnections?.();
else if (mode.endsWith('closeidle')) srv.closeIdleConnections?.();
await closed;
console.log('teardown done:', mode);
process.exit(0);
