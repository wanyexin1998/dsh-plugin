import { Children, cloneElement, isValidElement } from 'react';
import type { ReactNode, ReactElement } from 'react';
export interface LocaleFace { getSnapshot(): { active: string }; subscribe(fn: () => void): () => void }
const english: Record<string, string> = {
  '查询结果暂时无法读取。': 'Query results could not be read.', '查询繁忙，请稍后重试。': 'Query busy. Try again later.', '查询暂未完成，请稍后重试。': 'Query incomplete. Try again later.',
  '连接': 'Connect', '重连': 'Reconnect', '断开': 'Disconnect',
  '保留': 'Keep', '解除': 'Disconnect', '解除后需重新授权。': 'Reauthorization will be required.',
  '请联系 IT 开通数据权限。': 'Ask IT to enable data access.', '请重新授权或联系管理员。': 'Reauthorize or contact your administrator.', '请联系管理员确认权限。': 'Ask your administrator to check permissions.', '请联系 IT 开通 CLI 权限。': 'Ask IT to enable CLI access.', '请联系管理员确认应用权限。': 'Ask your administrator to check app permissions.', '请使用已绑定的账号。': 'Use your connected account.', '连接组件不可用': 'Connection component unavailable', '请重试连接或联系管理员。': 'Reconnect or contact your administrator.', '连接组件校验失败': 'Connection integrity check failed', '请联系管理员修复组件。': 'Ask your administrator to repair the component.', '请联系管理员检查配置。': 'Ask your administrator to check configuration.', '连接环境不可用': 'Connection environment unavailable', '请联系管理员检查运行目录。': 'Ask your administrator to check the runtime directory.',
  '正在准备连接': 'Preparing connection', '首次使用需下载组件。': 'Downloading required components.', '连接后可查询日程和文档。': 'Connect to query calendars and documents.', '请在新标签页授权。': 'Authorize in the new tab.', '请重新连接。': 'Please reconnect.', '需要时可重新连接。': 'Reconnect when needed.', '可继续查询。': 'Ready to query.', '请刷新状态或稍后重试。': 'Refresh or retry later.', '连接暂不可用': 'Connection unavailable', '请稍后重试。': 'Please try again later.',
  '正在准备…': 'Preparing…', '正在准备钉钉连接': 'Preparing DingTalk connection', '首次连接会自动准备官方 DWS，请稍候。': 'Preparing official DWS for the first connection. Please wait.',
  '钉钉连接': 'DingTalk connection', '钉钉工具连接': 'DingTalk tool connection', '钉钉': 'DingTalk',
  '钉钉已连接': 'DingTalk connected', '已连接': 'Connected', '连接钉钉': 'Connect DingTalk', '重新授权': 'Reauthorize',
  '刷新状态': 'Refresh status', '解除连接': 'Disconnect', '确认解除连接': 'Confirm disconnect', '保留连接': 'Keep connection',
  '解除钉钉连接？': 'Disconnect DingTalk?', '停止后续读取，并撤销此插件绑定账号的本地 DWS 凭据。再次使用需要重新授权。': 'Stop future reads and remove this plugin’s bound local DWS credentials. Authorization will be required again.',
  '钉钉只读查询': 'DingTalk read-only query', '暂不连接': 'Not now', '收起': 'Hide', '钉钉 · 显示连接': 'DingTalk · Show connection',
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
  '连接状态暂不可用': 'Connection status unavailable', '请稍后重试，已有凭证不会因此被清除。': 'Try again later. Existing credentials are retained.',
  '授权请求已失效': 'Authorization request expired', '请返回原会话重新发起授权。': 'Return to the original session and start again.',
  '请求过于频繁': 'Too many requests', '请稍后重试，无需解除现有连接。': 'Retry later. You do not need to disconnect.',
  '正在处理授权': 'Processing authorization', '请完成或取消本次授权后重试。': 'Complete or cancel the current authorization first.',
  '请协助核查并开通我的钉钉 DWS CLI 数据访问权限；同时确认企业 CLI 开关、账号范围、渠道限制及应用授权范围。谢谢。': 'Please review my DingTalk DWS CLI data access, including the enterprise CLI switch, account scope, channel restrictions and application scopes. Thank you.',
};
export function translate(text: string, language = 'zh'): string {
  if (language.startsWith('zh')) return text;
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
