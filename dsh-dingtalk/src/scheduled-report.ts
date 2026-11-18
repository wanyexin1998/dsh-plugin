import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { link, open, realpath, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { snapshot } from './file-transfer.js'

const CONVERT = [
  'import csv, io, sys',
  'from openpyxl import Workbook, load_workbook',
  'from openpyxl.cell import WriteOnlyCell',
  "reader = csv.reader(io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8-sig', newline=''), strict=True)",
  'book = Workbook(write_only=True)',
  "sheet = book.create_sheet('数据')",
  'rows = 0',
  'for row in reader:',
  '    rows += 1',
  '    if rows > 30000 or len(row) > 200: raise ValueError("CSV exceeds report limits")',
  '    cells = [WriteOnlyCell(sheet, value=value) for value in row]',
  "    for cell in cells: cell.data_type = 's'",
  '    sheet.append(cells)',
  'if not rows: raise ValueError("CSV is empty")',
  'target = io.BytesIO()',
  'book.save(target)',
  'target.seek(0)',
  'load_workbook(target, read_only=True).close()',
  'sys.stdout.buffer.write(target.getvalue())',
].join('\n')

export function reportInput(value: string): string {
  if (
    value.length > 260 ||
    !value.endsWith('.csv') ||
    value.split('/').some((part) => !part || part.startsWith('.') || /[\\:\x00-\x1f\x7f]/u.test(part))
  )
    throw new Error('scheduled_report_path_invalid')
  return value
}

async function convert(python: string, bytes: Buffer, signal: AbortSignal): Promise<Buffer> {
  const child = spawn(python, ['-I', '-c', CONVERT], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT },
    windowsHide: true,
    signal,
  })
  const chunks: Buffer[] = []
  let length = 0
  return new Promise((resolve, reject) => {
    let failed = false
    child.on('error', () => {
      failed = true
    })
    child.stdin.on('error', () => {
      failed = true
    })
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (length > 12 * 1024 * 1024) {
        failed = true
        child.kill()
        return
      }
      chunks.push(chunk)
    })
    child.on('close', (code) => {
      if (failed || code !== 0 || !length || signal.aborted) reject(new Error('scheduled_report_conversion_failed'))
      else resolve(Buffer.concat(chunks))
    })
    child.stdin.end(bytes)
  })
}

/** Publish a verified XLSX once inside the authorized report directory. */
export async function createScheduledReport(
  python: string,
  directory: string,
  input: string,
  name: string,
  signal: AbortSignal,
  authorize: () => void,
): Promise<void> {
  const data = await snapshot(directory, path.resolve(directory, reportInput(input)), signal)
  if (data.length > 4 * 1024 * 1024) throw new Error('scheduled_report_csv_too_large')
  const workbook = await convert(python, data, AbortSignal.any([signal, AbortSignal.timeout(30_000)]))
  authorize()
  const dir = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
  try {
    const anchored = process.platform === 'linux' ? '/proc/self/fd/' + dir.fd : directory
    if ((await realpath(anchored)) !== directory) throw new Error('scheduled_workspace_changed')
    const staged = path.join(anchored, '.scheduled-' + randomUUID())
    const file = await open(staged, 'wx', 0o600)
    try {
      try {
        await file.writeFile(workbook)
        await file.sync()
      } finally {
        await file.close()
      }
      authorize()
      signal.throwIfAborted()
      await link(staged, path.join(anchored, name))
    } finally {
      await unlink(staged)
    }
  } finally {
    await dir.close()
  }
}
