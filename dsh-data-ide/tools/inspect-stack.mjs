// Attach to a Node inspector and print the paused main-thread stack.
const port = process.argv[2] ?? '9231'

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const target = targets.find(entry => entry.webSocketDebuggerUrl)
if (!target) {
  console.error('no inspector target')
  process.exit(1)
}

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.onopen = resolve
  socket.onerror = reject
})

let nextId = 0
const paused = []
socket.onmessage = event => {
  const message = JSON.parse(event.data)
  if (message.method === 'Debugger.paused') paused.push(message.params)
}
const send = (method, params = {}) => socket.send(JSON.stringify({ id: ++nextId, method, params }))

send('Debugger.enable')
await new Promise(resolve => setTimeout(resolve, 300))
send('Debugger.pause')
await new Promise(resolve => setTimeout(resolve, 4000))

for (const params of paused) {
  for (const frame of (params.callFrames ?? []).slice(0, 18)) {
    const url = frame.url.replace(/^file:\/\/\//, '').split('/').slice(-3).join('/')
    console.log(`${frame.functionName || '(anonymous)'}  ${url}:${frame.lineNumber}`)
  }
}
if (paused.length === 0) console.error('no pause event captured')
process.exit(0)
