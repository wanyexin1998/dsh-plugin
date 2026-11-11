const ANSI = /\u001b\[[0-9;]*m/g

/**
 * Read the user code and verification URL from `dws auth login --device` stderr.
 * The CLI prints the code and the URL before it polls, and it writes the final JSON only to stdout.
 * @param text stderr captured so far
 * @returns the prompt once both fields are present
 */
export function parseDevicePrompt(text: string): { userCode: string; verificationUrl: string } | undefined {
  // stderr chunks can end halfway through the URL, even after a valid host.
  const end = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'))
  const plain = text.slice(0, end + 1).replace(ANSI, '')
  const codeMatch = plain.match(/(?:授权码|user code|authorization code)[:：]\s*([A-Za-z0-9-]{4,64})/i)
  const userCode = codeMatch?.[1]
  if (!userCode) return undefined
  const urls = [...plain.matchAll(/https?:\/\/[^\s<>"]+/g)].map((match) => match[0].replace(/[),.;]+$/, ''))
  const verificationUrl = urls.find((url) => url.includes(userCode)) ?? urls[0]
  if (!verificationUrl) return undefined
  return { userCode, verificationUrl }
}
