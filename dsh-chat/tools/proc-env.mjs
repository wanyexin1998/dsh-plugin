/**
 * Read the GUI auth token out of a process's environment block on Windows.
 *
 * The desktop app prints its URL with the token once at boot and keeps it in
 * the environment of the process it spawns; the renderer inherits it. This
 * recovers it so a diagnostic can talk to the local GUI the same way the
 * browser does, without a second server.
 *
 * Usage: node tools/proc-env.mjs <pid> [name]
 */

import { readFileSync } from 'node:fs'

const pid = Number(process.argv[2])
const wanted = process.argv[3]

/** Encode a WHATWG URL into a PowerShell file URL. */
function psUrl(url) {
  return `[System.Uri]::new(${JSON.stringify(url)})`
}

// One PowerShell command: read the target PEB and emit requested variables.
const script = `
$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class PebReader {
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_BASIC_INFORMATION {
    public IntPtr Reserved1; public IntPtr PebBaseAddress; public IntPtr Reserved2_0; public IntPtr Reserved2_1; public IntPtr UniqueProcessId; public IntPtr Reserved3;
  }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, ref PROCESS_BASIC_INFORMATION i, int l, out int r);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(int a, bool i, int p);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr b, byte[] buf, int size, out IntPtr read);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static string Env(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) return "ERR:OpenProcess";
    try {
      var pbi = new PROCESS_BASIC_INFORMATION();
      int rl; if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out rl) != 0) return "ERR:NtQuery";
      byte[] ptr = new byte[8]; IntPtr read;
      if (!ReadProcessMemory(h, pbi.PebBaseAddress + 0x20, ptr, 8, out read)) return "ERR:ReadPeb";
      long procParams = BitConverter.ToInt64(ptr, 0);
      byte[] envPtrBuf = new byte[8];
      if (!ReadProcessMemory(h, (IntPtr)(procParams + 0x80), envPtrBuf, 8, out read)) return "ERR:ReadParams";
      long env = BitConverter.ToInt64(envPtrBuf, 0);
      if (env == 0) return "ERR:NoEnv";
      byte[] buf = new byte[65536];
      if (!ReadProcessMemory(h, (IntPtr)env, buf, buf.Length, out read)) return "ERR:ReadEnv";
      var sb = new StringBuilder();
      for (int i = 0; i + 4 <= (int)read; i += 2) {
        int c = BitConverter.ToUInt16(buf, i);
        if (c == 0) { if (sb.Length == 0) break; sb.Append('\\n'); continue; }
        sb.Append((char)c);
      }
      return sb.ToString();
    } finally { CloseHandle(h); }
  }
}
'@
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue
$env_text = [PebReader]::Env(${pid})
$env_text
`

const { execFileSync } = await import('node:child_process')
const output = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
if (output.startsWith('ERR:')) {
  console.error(output.trim())
  process.exit(1)
}
const pairs = output.split('\n').map(line => line.trim()).filter(line => line.includes('='))
const found = new Map()
for (const pair of pairs) {
  const index = pair.indexOf('=')
  found.set(pair.slice(0, index), pair.slice(index + 1))
}
if (wanted === undefined) {
  for (const [key, value] of found) console.log(`${key}=${value}`)
} else if (found.has(wanted)) {
  console.log(found.get(wanted))
} else {
  console.error(`not found: ${wanted}`)
  process.exit(1)
}
