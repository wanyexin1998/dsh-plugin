import type { ReasonCode } from './models.js';
export const messages: Partial<Record<ReasonCode, { title: string; detail: string; admin?: boolean }>> = {
  org_policy_denied: { title: '组织数据权限策略限制', detail: '当前工具所需的 DWS/PAT 数据权限被组织策略禁止，请联系 IT 管理员核查对应 scope。', admin: true },
  scope_authorization_required: { title: '需要补充数据授权', detail: '当前账号缺少此工具所需的授权范围，请核查应用及用户授权后重试。' },
  permission_denied: { title: '当前数据访问未获授权', detail: '请联系管理员核查本项工具的数据访问权限。' },
  rate_limited: { title: '请求过于频繁', detail: '请稍后重试，无需解除现有连接。' },
  invalid_auth_state: { title: '授权请求已失效', detail: '请返回原会话重新发起授权。' },
  authorization_busy: { title: '正在处理授权', detail: '请完成或取消本次授权后重试。' },
  not_connected: { title: '尚未连接钉钉', detail: '连接后可读取本人信息、日程和可访问的文档。' },
  authorization_pending: { title: '等待钉钉授权', detail: '请在新标签页完成授权。本会话和草稿会保留。' },
  authorization_expired: { title: '授权已失效', detail: '请重新授权后再试。' },
  org_cli_disabled: { title: '企业尚未开通 CLI 权限', detail: '当前企业账号尚未开通钉钉 DWS CLI 访问权限，请联系公司 IT 管理员开通后重试。', admin: true },
  app_permission_denied: { title: '应用权限不足', detail: '请联系应用管理员核查授权范围，与企业 CLI 开通状态分别确认。' },
  identity_mismatch: { title: '授权账号不一致', detail: '请切换为当前绑定的正确企业账号后重试。' },
  user_cancelled: { title: '已取消本次授权', detail: '原会话和已有连接不会因取消而退出。' },
  auth_timeout: { title: '授权已超时', detail: '请重新发起授权，旧授权链接已失效。' },
  cli_missing: { title: '尚未配置 DWS', detail: '请按插件安装说明配置已校验的官方 DWS，再重新连接。' },
  cli_integrity_failed: { title: 'DWS 版本校验未通过', detail: '请安装兼容版本，插件不会运行未验证的程序。' },
  cli_version_unsupported: { title: 'DWS 版本不兼容', detail: '请使用当前插件兼容矩阵中的版本。' },
  cli_platform_unsupported: { title: '当前平台尚未验收', detail: '请查看插件兼容矩阵。' },
  oauth_not_configured: { title: '授权配置尚未就绪', detail: '请先完成 Host 私有应用配置。' },
  privacy_guard_required: { title: '私有运行目录尚未就绪', detail: '为保护查询隐私，请按插件说明配置独立运行目录。' },
  revocation_failed: { title: '连接已阻断，撤销尚未完成', detail: '后续调用已停止，请重试解除连接。' },
  verification_failed_after_save: { title: '授权尚未完成业务验证', detail: '凭证已交给 DWS 保存，但业务权限尚无法确认，请重新授权或联系管理员核查。' },
  connection_unknown: { title: '暂无法确认连接', detail: '请重试；无法判断原因时联系管理员核查，不会据此删除凭证。' },
};
export function messageFor(reason: ReasonCode | undefined) {
  return (reason && messages[reason]) || { title: '连接状态暂不可用', detail: '请稍后重试，已有凭证不会因此被清除。' };
}
export const IT_REQUEST = '请协助核查并开通我的钉钉 DWS CLI 数据访问权限；同时确认企业 CLI 开关、账号范围、渠道限制及应用授权范围。谢谢。';
