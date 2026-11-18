import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readlink, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import type { HostAgent, HostAgentContext, HostToolDefinition, HostToolExecution } from './host.js'
import { FILE_TYPES, IMAGE_TYPES, matchesImageType, MAX_MEDIA_BYTES } from './media.js'
import { DeliveryOutcomeUnknown } from './errors.js'
import type { MediaTarget, MediaReceipt, OutboundMedia, Outbound } from './outbound.js'

interface FileRoute {
  agent: HostAgent
  target: MediaTarget
  cwd: string
  requestId?: string
}

interface EnterpriseAttachment {
  signal(agent: HostAgent): AbortSignal
  send(requestId: string, media: OutboundMedia, signal: AbortSignal): Promise<MediaReceipt>
}

// Read through the verified descriptor and send only the copied bytes.
export async function snapshot(root: string, file: string, signal: AbortSignal): Promise<Buffer> {
  const denied = () => new Error('file_outside_workspace: 只允许发送当前工作区内的普通文件，不支持链接。')
  const select = async () => {
    if ((await realpath(root)) !== root) throw denied()
    let current = root
    for (const part of path.relative(root, file).split(path.sep)) {
      current = path.join(current, part)
      if ((await lstat(current)).isSymbolicLink()) throw denied()
    }
    if ((await realpath(file)) !== file) throw denied()
    const stat = await lstat(file, { bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n) throw denied()
    return stat
  }
  const before = await select()
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = await handle.stat({ bigint: true })
    const same = (other: typeof stat) => other.dev === stat.dev && other.ino === stat.ino
    if (!stat.isFile() || stat.nlink !== 1n || !same(before) || !same(await select())) throw denied()
    if (process.platform === 'linux' && (await readlink(`/proc/self/fd/${handle.fd}`)) !== file) throw denied()
    if (stat.size < 1n || stat.size > BigInt(MAX_MEDIA_BYTES))
      throw new Error('file_too_large_or_empty: 附件必须非空，且不超过 20 MB。')
    const data = Buffer.alloc(Number(stat.size))
    for (let offset = 0; offset < data.length;) {
      signal.throwIfAborted()
      const { bytesRead } = await handle.read(data, offset, Math.min(64 * 1024, data.length - offset))
      if (!bytesRead) throw new Error('file_changed: 附件在读取时发生变化，请保存后重新发送。')
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (
      after.nlink !== 1n ||
      after.size !== stat.size ||
      after.mtimeNs !== stat.mtimeNs ||
      after.ctimeNs !== stat.ctimeNs
    )
      throw new Error('file_changed: 附件在读取时发生变化，请保存后重新发送。')
    return data
  } finally {
    await handle.close()
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function safeName(name: string): string {
  const basename = name.split(/[\\/]/).at(-1) ?? ''
  let cleaned = ''
  for (const character of basename.replace(/[<>:"|?*\u0000-\u001f\u007f]/g, '_')) {
    if (Buffer.byteLength(cleaned + character) > 180) break
    cleaned += character
  }
  cleaned = cleaned.replace(/[. ]+$/, '')
  return !cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned) ? 'attachment' : cleaned
}

/** 每个机器人独立持有文件通道；模型只提供路径，不提供收件人、账号或凭据。 */
export class FileTransfer {
  private readonly installed = new WeakMap<HostAgentContext, () => void>()
  private readonly routes = new Map<string, FileRoute>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly abort = new AbortController()
  private sendingAttachment = false

  constructor(
    private readonly opts: {
      accountId: string
      outbound: Pick<Outbound, 'sendMedia'>
      log(line: string): void
      attachment?: EnterpriseAttachment
    },
  ) {}

  get signal(): AbortSignal {
    return this.abort.signal
  }

  bindSession(agent: HostAgent, target: MediaTarget, cwd: string, requestId?: string): void {
    if (this.abort.signal.aborted) return
    this.routes.set(agent.id, {
      agent,
      target: {
        conversationType: target.conversationType,
        conversationId: target.conversationId,
        senderStaffId: target.senderStaffId,
      },
      cwd,
      requestId,
    })
  }

  canSendAttachment(agent: HostAgent): boolean {
    const route = this.routes.get(agent.id)
    return !!(
      this.opts.attachment &&
      !this.abort.signal.aborted &&
      route?.agent === agent &&
      route.target.conversationType === 'direct' &&
      route.requestId
    )
  }

  install(ctx: HostAgentContext, agent: HostAgent, offerAttachment?: boolean): void {
    if (offerAttachment === false) {
      this.installed.get(ctx)?.()
      this.installed.delete(ctx)
      return
    }
    if (this.installed.has(ctx)) return
    const file = ctx.tools.register(this.definition('file', agent))
    if (!this.opts.attachment) {
      this.installed.set(ctx, file)
      return
    }
    try {
      const image = ctx.tools.register(this.definition('image', agent))
      this.installed.set(ctx, () => {
        image()
        file()
      })
    } catch (error) {
      file()
      throw error
    }
  }

  async close(): Promise<void> {
    this.routes.clear()
    this.abort.abort()
    await Promise.allSettled([...this.pending])
  }

  /** 独立随机目录与独占创建避免覆盖；逐层拒绝符号链接，不使用用户名称构造父目录。 */
  async storeInbound(
    cwd: string,
    scopeKey: string,
    name: string,
    data: Uint8Array,
  ): Promise<{ path: string; bytes: number }> {
    if (data.length > MAX_MEDIA_BYTES) throw new Error('file_too_large')
    this.abort.signal.throwIfAborted()
    const root = await realpath(cwd)
    let directory = root
    for (const segment of ['.dsh-dingtalk', 'inbox', hash(this.opts.accountId), hash(scopeKey), randomUUID()]) {
      directory = path.join(directory, segment)
      await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
      const stat = await lstat(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(directory)) !== directory)
        throw new Error('unsafe_inbox')
    }
    const file = path.join(directory, safeName(name))
    const handle = await open(file, 'wx', 0o600)
    try {
      this.abort.signal.throwIfAborted()
      await handle.writeFile(data, { signal: this.abort.signal })
    } catch (error) {
      await handle.close()
      await rm(file, { force: true })
      throw error
    }
    await handle.close()
    return { path: file, bytes: data.length }
  }

  private definition(kind: 'file' | 'image', agent: HostAgent): HostToolDefinition {
    return {
      name: kind === 'file' ? 'send_file' : 'send_image',
      description:
        kind === 'image'
          ? '仅在用户要求回传图片时，将当前员工工作区中的 JPG、JPEG、PNG、GIF 或 BMP 图片发回原钉钉私聊。图片内容须与扩展名一致，最大 20 MB。只提供工作区内路径。发送结果未知时先请用户检查聊天，不要自动重发。'
          : this.opts.attachment
            ? '将当前员工工作区内的文件（xlsx/pdf/zip/rar/doc/docx）以可下载附件发回原钉钉私聊。仅在用户要求回传时使用，无需再次确认。只提供工作区内路径，最大 20 MB。发送结果未知时先请用户检查聊天，不要自动重发。'
            : '仅在用户要求回传文件时，将当前工作区中的文件（xlsx/pdf/zip/rar/doc/docx）发回当前钉钉会话。最大 20 MB。path 是相对于工作区或工作区内的绝对路径。接口接受不代表客户端已送达；结果未知时不要自动重发。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string', description: '工作区内待发送文件的路径' } },
        required: ['path'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { status: { type: 'string', enum: ['accepted'] }, processQueryKey: { type: 'string' } },
          required: ['status', 'processQueryKey'],
        },
        render: (_args, value) => [
          { type: 'text', text: `钉钉接口已接受发送，客户端送达尚未验证：${JSON.stringify(value)}` },
        ],
      },
      timeoutMs: 90_000,
      execute: (args, exec) => {
        const task = this.send(kind, agent, args, exec)
        this.pending.add(task)
        void task.finally(() => this.pending.delete(task)).catch(() => undefined)
        return task
      },
    }
  }

  private async send(kind: 'file' | 'image', agent: HostAgent, args: unknown, exec: HostToolExecution) {
    if (exec.agent !== agent) throw new Error('file_agent_mismatch')
    const route = this.routes.get(agent.id)
    if (!route || route.agent !== agent || this.abort.signal.aborted) throw new Error('file_route_unavailable')
    if (
      !args ||
      typeof args !== 'object' ||
      Object.keys(args).length !== 1 ||
      !('path' in args) ||
      typeof args.path !== 'string' ||
      !args.path.trim() ||
      args.path.includes('\0')
    )
      throw new Error('file_invalid_arguments')
    if (this.opts.attachment) {
      if (!this.canSendAttachment(agent) || !route.requestId) throw new Error('file_route_unavailable')
      return this.sendEnterpriseAttachment(this.opts.attachment, route, route.requestId, kind, args.path, exec)
    }
    const signal = AbortSignal.any([exec.signal, this.abort.signal])
    signal.throwIfAborted()
    const root = await realpath(route.cwd)
    // macOS 的 /var 与 /private/var 可指向同一工作区；同时接受所选路径和规范路径。
    const selectedRoot = path.resolve(route.cwd)
    const requested = path.resolve(selectedRoot, args.path)
    if (!inside(selectedRoot, requested) && !inside(root, requested)) throw new Error('file_outside_workspace')
    const actual = await realpath(requested)
    if (!inside(root, actual)) throw new Error('file_outside_workspace')
    if (!(await lstat(actual)).isFile()) throw new Error('file_not_regular')
    const name = path.basename(actual)
    const extension = path.extname(name).slice(1).toLowerCase()
    if (!FILE_TYPES.has(extension)) throw new Error('unsupported_file_type')
    const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    let data: Uint8Array
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw new Error('file_not_regular')
      if (!stat.size || stat.size > MAX_MEDIA_BYTES) throw new Error('file_too_large_or_empty')
      const chunks: Buffer[] = []
      let size = 0
      while (true) {
        signal.throwIfAborted()
        const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_MEDIA_BYTES + 1 - size))
        const { bytesRead } = await handle.read(chunk)
        if (!bytesRead) break
        size += bytesRead
        if (size > MAX_MEDIA_BYTES) throw new Error('file_too_large')
        chunks.push(chunk.subarray(0, bytesRead))
      }
      data = new Uint8Array(Buffer.concat(chunks, size))
    } finally {
      await handle.close()
    }
    signal.throwIfAborted()
    return this.opts.outbound.sendMedia(route.target, { kind: 'file', name, data }, signal)
  }
  private async sendEnterpriseAttachment(
    attachment: EnterpriseAttachment,
    route: FileRoute,
    requestId: string,
    kind: OutboundMedia['kind'],
    input: string,
    exec: HostToolExecution,
  ): Promise<MediaReceipt> {
    if (this.sendingAttachment) throw new Error('file_send_busy: 请等待当前附件发送结束。')
    this.sendingAttachment = true
    try {
      const lease = attachment.signal(route.agent)
      const signal = AbortSignal.any([exec.signal, this.abort.signal, lease])
      const check = () => {
        if (signal.aborted || attachment.signal(route.agent) !== lease || this.routes.get(route.agent.id) !== route)
          throw new Error('file_authorization_changed: 发送授权已失效，请在当前钉钉私聊重新发起。')
      }
      check()
      // The enterprise admission already pins a canonical cwd. Do not resolve a replacement root.
      const root = route.cwd
      const file = path.resolve(root, input)
      if (
        !inside(root, file) ||
        input.split(/[/\\]/).includes('..') ||
        path
          .relative(root, file)
          .split(path.sep)
          .some((part) => part.startsWith('.') || part.includes(':'))
      )
        throw new Error('file_outside_workspace: 只允许发送当前工作区内的普通文件。')
      const name = path.basename(file)
      const extension = path.extname(name).slice(1).toLowerCase()
      if (
        safeName(name) !== name ||
        /[`\u202a-\u202e\u2066-\u2069]/.test(name) ||
        !(kind === 'file' ? FILE_TYPES : IMAGE_TYPES).has(extension)
      )
        throw new Error('unsupported_file_type: 附件名称或格式不受支持。')
      const data = await snapshot(root, file, signal).catch((error: NodeJS.ErrnoException) => {
        check()
        if (error.code) throw new Error('file_unavailable: 无法读取此附件，请检查路径和权限。')
        throw error
      })
      check()
      if (kind === 'image' && !matchesImageType(extension, data))
        throw new Error('file_image_type_mismatch: 图片内容与扩展名不符。')
      const sending = Date.now()
      try {
        return await attachment.send(requestId, { kind, name, data }, signal)
      } catch (error) {
        if (error instanceof DeliveryOutcomeUnknown)
          throw new Error('file_delivery_unknown: 发送结果未确认，请先查看钉钉私聊，勿自动重发。')
        throw new Error('file_send_failed: 附件未发送，请联系管理员检查机器人网关或上传权限。')
      } finally {
        this.opts.log(`attachment send settled (${Date.now() - sending} ms)`)
      }
    } finally {
      this.sendingAttachment = false
    }
  }
}
