import { Children, cloneElement, isValidElement } from 'react';
import type { ReactNode, ReactElement } from 'react';
export interface LocaleFace { getSnapshot(): { active: string }; subscribe(fn: () => void): () => void }
const english: Record<string, string> = {
  '首次配置需确认企业信息；尚无企业信息时，请先在上方完成 DWS 授权。配置后连接机器人并按提示完成设备配对。': 'First-time setup needs confirmed organization details. If none are available, authorize DWS above to obtain them. Then connect the robot and follow the device pairing prompts.',
  '机器人通过应用登录与此设备配对。钉钉数据授权在上方单独管理。': 'The robot pairs with this device through application sign-in. DingTalk data authorization is managed separately above.',
  '请重新连接机器人，按提示完成应用登录与设备配对。': 'Reconnect the robot and follow the application sign-in and device pairing prompts.',
  '请使用此机器人所属企业的账号完成配对。': 'Pair using an account from the organization configured for this robot.',
  '请重新登录机器人': 'Sign in to the robot again',
  '请在机器人应用登录页确认账号与此设备的配对。': 'Confirm the account and device pairing on the robot application sign-in page.',

  '机器人操作结果尚未确认，请刷新状态。': 'Robot action outcome is unconfirmed. Refresh status.',
  '状态未知': 'Status unknown', '刷新机器人状态': 'Refresh robot status', '正在刷新机器人状态…': 'Refreshing robot status…',
  '暂时无法读取机器人状态，请重试。': 'Could not read robot status. Retry.', '机器人状态读取失败；显示上次确认状态。': 'Robot status read failed; showing the last confirmed status.',
  '钉钉机器人': 'DingTalk robot', '配置': 'Configure', '未配置': 'Not configured', '连接中': 'Connecting', '等待登录确认': 'Waiting for sign-in', '未连接': 'Not connected',
  '取消登录': 'Cancel sign-in', '断开机器人': 'Disconnect robot', '停止托管': 'Stop hosting', '验证中': 'Verifying', '下一步': 'Next', '取消配置': 'Cancel configuration', '继续登录': 'Continue sign-in', '网关地址': 'Gateway address',
  '此配置已在另一 DSH 实例运行': 'Configuration active in another DSH instance', '当前通道未提供连接管理': 'Connection management unavailable in this channel',
  '企业配置有误': 'Invalid enterprise configuration', '请先停用个人托管': 'Stop personal hosting first', '本机配置有误': 'Invalid local configuration',
  '端口被占用或另一 DSH 正在托管': 'Port in use or hosted by another DSH instance', '本机服务暂不可用': 'Local service unavailable', '机器人消息连接失败': 'Robot message connection failed',
  '离线 · 正在重连': 'Offline · Reconnecting', '请重新授权': 'Please reauthorize', '已在其他设备连接': 'Connected on another device', '已取消': 'Cancelled', '登录已超时': 'Sign-in timed out', '连接未完成': 'Connection incomplete',
  '请先完成上方钉钉账号授权。': 'Complete DingTalk account authorization above first.', '应用凭据无效或验证暂不可用，请检查后重试。': 'Invalid application credentials or verification unavailable. Check and retry.',
  '请使用与当前 DWS 相同的企业账号。': 'Use the same enterprise account as the current DWS connection.', '本机端口被占用，或另一 DSH 正在托管此机器人。': 'Local port in use, or this robot is hosted by another DSH instance.',
  '此配置已在另一 DSH 实例运行。': 'This configuration is running in another DSH instance.', '请先停止托管，再修改应用凭据。': 'Stop hosting before editing application credentials.',
  '连接未完成，请检查应用设置后重试。': 'Connection incomplete. Check application settings and retry.', '在钉钉应用的安全设置中登记重定向 URL：': 'Register this redirect URL in the DingTalk application security settings:',
  '复制回调地址': 'Copy callback URL', '请手动复制回调地址。': 'Copy the callback URL manually.', '请在打开的页面确认。': 'Confirm on the page that opened.',
  '连接后，机器人消息将交给这台 DSH。': 'Once connected, robot messages go to this DSH instance.',

  '检查中': 'Checking', '正在读取连接状态，请稍候。': 'Reading connection status. Please wait.',
  '连接状态读取失败': 'Could not read connection status', '暂无法确认授权状态，请刷新重试。': 'Authorization status is unknown. Refresh to retry.',
  '上次确认已连接': 'Last confirmed connected', '读取失败 · 状态待更新，请重试。': 'Read failed · Status needs updating. Retry.',
  '刷新中 · 保留上次确认状态。': 'Refreshing · Showing the last confirmed status.', '账户信息来自上次确认。': 'Account details are from the last successful check.', '上次确认：': 'Last confirmed: ',

  '组件下载中断': 'Component download interrupted', '组件下载超时': 'Component download timed out', '请检查网络后重试，将继续下载。': 'Check your network and retry to resume.', '正在校验组件…': 'Verifying component…', '组件下载进度': 'Component download progress',
  '日程与待办': 'Calendar & tasks', '查询与管理': 'View & manage', '文档与表格': 'Docs & sheets', '读取与编辑': 'Read & edit', '消息与更多': 'Messages & more', '按账号权限': 'Account permissions',
  '按你的指令操作，写入前确认。': 'Act on your instructions. Confirm before changes.', '解除后将停止调用与后台任务。再次使用需重新连接。': 'Disconnect stops calls and background tasks. Reconnect to use again.',
  '连接后即可使用钉钉功能。': 'Connect to use DingTalk.', '钉钉 · 已完成': 'DingTalk · Done', '钉钉 · 处理中…': 'DingTalk · Working…',
  '结果待确认，请先查询，勿重复提交。': 'Check the result before submitting again.', '此操作需要确认。': 'Confirmation required.', '已取消操作。': 'Operation cancelled.', '请使用会话工作区内的文件。': 'Use files in the conversation workspace.', '官方暂未开放此功能。': 'Not available from DingTalk yet.', '请在设置或管理员工具中管理。': 'Manage this in settings or admin tools.', '未找到此功能。': 'Command not found.', '当前会话未找到此任务。': 'Task not found in this conversation.', '后台任务已满。': 'Background task limit reached.',
  '关闭弹窗': 'Close dialog', '解除后将停止读取数据。再次使用需重新连接。': 'Disconnecting stops data access. Reconnect to use it again.',
  '账号信息': 'Account', '识别当前账号': 'Current account', '日程': 'Calendar', '只读': 'Read only', '你有权限的文档': 'Accessible documents',
  '打开': 'Open', '准备中': 'Preparing', '等待中': 'Waiting', '重试解除连接': 'Retry disconnect', '重试': 'Retry', '复制': 'Copy', '复制申请': 'Copy request', '已复制': 'Copied',
  '复制未成功，请手动复制：': 'Copy failed. Select and copy this request:', '申请文案': 'Access request', '在对话中使用你的工作信息。': 'Use your work information in conversations.',
  '连接管理': 'Manage connection', '已授权账号': 'Authorized account', '已验证企业': 'Verified organization', '连接后可用': 'Available when connected',
  '仅按你的指令读取，不会自动发送消息。': 'Reads only when requested. Never sends messages automatically.', '复制给管理员': 'Copy for administrator', '连接状态': 'Connection status',

  '查询结果暂时无法读取。': 'Query results could not be read.', '查询繁忙，请稍后重试。': 'Query busy. Try again later.', '查询暂未完成，请稍后重试。': 'Query incomplete. Try again later.',
  '连接': 'Connect', '重连': 'Reconnect', '断开': 'Disconnect',
  '保留': 'Keep', '解除': 'Disconnect', '解除后需重新授权。': 'Reauthorization will be required.',
  '请联系 IT 开通数据权限。': 'Ask IT to enable data access.', '请重新授权或联系管理员。': 'Reauthorize or contact your administrator.', '请联系管理员确认权限。': 'Ask your administrator to check permissions.', '请联系 IT 开通 CLI 权限。': 'Ask IT to enable CLI access.', '请联系管理员确认应用权限。': 'Ask your administrator to check app permissions.', '请使用已绑定的账号。': 'Use your connected account.', '连接组件不可用': 'Connection component unavailable', '请重试连接或联系管理员。': 'Reconnect or contact your administrator.', '连接组件校验失败': 'Connection integrity check failed', '请联系管理员修复组件。': 'Ask your administrator to repair the component.', '请联系管理员检查配置。': 'Ask your administrator to check configuration.', '连接环境不可用': 'Connection environment unavailable', '请联系管理员检查运行目录。': 'Ask your administrator to check the runtime directory.',
  '正在准备连接': 'Preparing connection', '首次使用需下载组件。': 'Downloading required components.', '连接后可查询日程和文档。': 'Connect to query calendars and documents.', '请在新标签页授权。': 'Authorize in the new tab.', '请在打开的页面确认钉钉登录。': 'Confirm the DingTalk login on the opened page.', '请重新连接。': 'Please reconnect.', '需要时可重新连接。': 'Reconnect when needed.', '可继续查询。': 'Ready to query.', '请刷新状态或稍后重试。': 'Refresh or retry later.', '连接暂不可用': 'Connection unavailable', '请稍后重试。': 'Please try again later.',
  '正在准备…': 'Preparing…', '正在准备钉钉连接': 'Preparing DingTalk connection', '首次连接会自动准备官方 DWS，请稍候。': 'Preparing official DWS for the first connection. Please wait.',
  '钉钉连接': 'DingTalk connection', '钉钉工具连接': 'DingTalk tool connection', '钉钉': 'DingTalk',
  '钉钉已连接': 'DingTalk connected', '已连接': 'Connected', '连接钉钉': 'Connect DingTalk', '重新授权': 'Reauthorize',
  '刷新状态': 'Refresh status', '解除连接': 'Disconnect', '确认解除连接': 'Confirm disconnect', '保留连接': 'Keep connection',
  '解除钉钉连接？': 'Disconnect DingTalk?', '停止后续读取，并撤销此插件绑定账号的本地 DWS 凭据。再次使用需要重新授权。': 'Stop future reads and remove this plugin’s bound local DWS credentials. Authorization will be required again.',
  '钉钉只读查询': 'DingTalk read-only query', '暂不连接': 'Not now', '收起': 'Hide', '钉钉 · 显示连接': 'DingTalk · Show connection',
  '钉钉 · 等待连接': 'DingTalk · Waiting for connection',
  '钉钉 · 正在读取…': 'DingTalk · Reading…', '钉钉 · 查询完成': 'DingTalk · Query complete',
  '可继续刚才的查询。': 'You can continue your query.', '可继续刚才的查询。连接不会自动发送消息或执行查询。': 'You can continue your query. Connecting does not send a message or run a query automatically.',
  '请在新标签页完成授权。': 'Complete authorization in the new tab.', '正在打开…': 'Opening…', '取消': 'Cancel',
  '打开授权页': 'Open authorization', '取消本次授权': 'Cancel authorization',
  '浏览器拦截了弹窗，点击打开授权页': 'Popup blocked. Open authorization',
  '复制给 IT 的申请文案': 'Copy request for IT', '已复制申请文案': 'Request copied',
  '尚未连接钉钉': 'DingTalk is not connected', '连接后可读取本人信息、日程和可访问的文档。': 'Connect to read your profile, calendar and accessible documents.',
  '等待钉钉授权': 'Waiting for authorization', '请在新标签页完成授权。本会话和草稿会保留。': 'Authorize in the new tab. Your session and draft will remain.',
  '授权已失效': 'Authorization expired', '请重新授权后再试。': 'Reauthorize and try again.',
  '企业尚未开通 CLI 权限': 'Enterprise CLI access is not enabled', '当前企业账号尚未开通钉钉 DWS CLI 访问权限，请联系公司 IT 管理员开通后重试。': 'This enterprise account does not have DingTalk DWS CLI access enabled. Ask your IT administrator to enable it, then retry.',
  '应用权限不足': 'Insufficient application permissions', '请联系应用管理员核查授权范围，与企业 CLI 开通状态分别确认。': 'Ask the application administrator to check scopes separately from enterprise CLI access.',
  '组织数据权限策略限制': 'Organization data policy restriction', '当前工具所需的 DWS/PAT 数据权限被组织策略禁止，请联系 IT 管理员核查对应 scope。': 'Organization policy denies the required DWS/PAT scope. Ask IT to review it.',
  '需要补充数据授权': 'Additional authorization required', '当前账号缺少此工具所需的授权范围，请核查应用及用户授权后重试。': 'Check the application and user scopes required for this tool, then retry.',
  '当前数据访问未获授权': 'Data access is not authorized', '请联系管理员核查本项工具的数据访问权限。': 'Ask an administrator to check data access for this tool.',
  '授权账号不一致': 'Account mismatch', '请切换为当前绑定的正确企业账号后重试。': 'Select the expected enterprise account and retry.',
  '已取消本次授权': 'Authorization cancelled', '原会话和已有连接不会因取消而退出。': 'Your session and existing connection are retained.',
  '授权已超时': 'Authorization timed out', '请重新发起授权，旧授权链接已失效。': 'Start authorization again. The old link has expired.',
  '尚未配置 DWS': 'DWS is not configured', '请按插件安装说明配置已校验的官方 DWS，再重新连接。': 'Configure the verified official DWS version described in the installation guide, then reconnect.',
  'DWS 版本校验未通过': 'DWS integrity check failed', '请安装兼容版本，插件不会运行未验证的程序。': 'Install a supported verified version.',
  'DWS 版本不兼容': 'Unsupported DWS version', '请使用当前插件兼容矩阵中的版本。': 'Use a version listed in the compatibility matrix.',
  '当前平台尚未验收': 'Platform not yet accepted', '请查看插件兼容矩阵。': 'See the compatibility matrix.',
  '授权配置尚未就绪': 'Authorization is not configured', '请先完成 Host 私有应用配置。': 'Complete the Host private application configuration.',
  '私有运行目录尚未就绪': 'Private runtime is not ready', '为保护查询隐私，请按插件说明配置独立运行目录。': 'Configure the private runtime directory described in the plugin guide.',
  '连接已阻断，撤销尚未完成': 'Access blocked; removal incomplete', '后续调用已停止，请重试解除连接。': 'Future calls are blocked. Retry disconnecting.',
  '授权尚未完成业务验证': 'Business verification incomplete', '凭证已交给 DWS 保存，但业务权限尚无法确认，请重新授权或联系管理员核查。': 'DWS saved credentials, but business access could not be verified. Reauthorize or ask an administrator.',
  '暂无法确认连接': 'Connection could not be verified', '请重试；无法判断原因时联系管理员核查，不会据此删除凭证。': 'Retry or ask an administrator. Credentials are retained.',
  '钉钉换票失败': 'DingTalk token exchange failed', '授权码没有换成访问令牌，请重新连接。': 'The authorization code was not exchanged for an access token. Connect again.',
  '连接状态暂不可用': 'Connection status unavailable', '请稍后重试，已有凭证不会因此被清除。': 'Try again later. Existing credentials are retained.',
  '授权请求已失效': 'Authorization request expired', '请返回原会话重新发起授权。': 'Return to the original session and start again.',
  '请求过于频繁': 'Too many requests', '请稍后重试，无需解除现有连接。': 'Retry later. You do not need to disconnect.',
  '正在处理授权': 'Processing authorization', '请完成或取消本次授权后重试。': 'Complete or cancel the current authorization first.',
  '请协助核查并开通我的钉钉 DWS CLI 数据访问权限；同时确认企业 CLI 开关、账号范围、渠道限制及应用授权范围。谢谢。': 'Please review my DingTalk DWS CLI data access, including the enterprise CLI switch, account scope, channel restrictions and application scopes. Thank you.',
};
export function translate(text: string, language = 'zh'): string {
  if (language.startsWith('zh')) return text;
  if (text.startsWith('正在下载组件 · ')) return 'Downloading component · ' + text.slice('正在下载组件 · '.length);
  if (text.startsWith('最近验证：')) return 'Last verified: ' + text.slice(5);
  if (text.startsWith('可用能力：')) return 'Verified capabilities: ' + text.slice(5);
  if (text === '已验证企业 · 已授权账号') return 'Verified organization · Authorized account';
  return english[text] ?? text;
}
export function localize(node: ReactNode, language = 'zh'): ReactNode {
  if (language.startsWith('zh')) return node;
  return Children.map(node, child => {
    if (typeof child === 'string') return translate(child, language);
    if (!isValidElement(child)) return child;
    const element = child as ReactElement<{ children?: ReactNode; 'aria-label'?: string; label?: string; title?: string; caption?: string }>;
    const label = element.props['aria-label'];
    return cloneElement(element, { ...(label ? { 'aria-label': translate(label, language) } : {}), ...(element.props.label ? { label: translate(element.props.label, language) } : {}), ...(element.props.title ? { title: translate(element.props.title, language) } : {}), ...(element.props.caption ? { caption: translate(element.props.caption, language) } : {}), children: localize(element.props.children, language) });
  });
}
