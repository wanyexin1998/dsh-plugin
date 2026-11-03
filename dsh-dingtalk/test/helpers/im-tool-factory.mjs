import { dingtalkTool } from '../../enhancements/lib/host/tool.js'

// Channel component fixtures do not call DWS. Use the real tool schema, with an
// explicitly disconnected reader; authorization integration is tested separately.
export const imToolFactory = {
  createTool(_identity, host) {
    return dingtalkTool({ invoke: async () => ({ status: 'auth_required', reasonCode: 'not_connected' }) }, host)
  },
}
