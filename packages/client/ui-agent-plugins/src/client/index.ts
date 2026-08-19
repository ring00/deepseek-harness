import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import agentPluginRemote from '@deepseek-ai/dsh-agent-plugins/remote'
import type {} from '@deepseek-ai/dsh-agent-plugins/remote'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { AgentPluginsView, type AgentPluginsViewInjected } from './AgentPluginsView.tsx'
import { en, zh, type AgentPluginsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'agent-plugins': AgentPluginsLocaleKey }
}

export const inject = ['slots', 'sessions', 'locale', 'remote']
/** Mount the inventory Remote and contribute one conversation view. */
export async function apply(ctx: ClientContext): Promise<void> {
  const disposeRemote = await ctx.remote.$mount(agentPluginRemote)
  ctx.effect(() => disposeRemote, 'ui-agent-plugins.remote')
  ctx.inject(['remote.agentPlugin'], (remoteCtx: ClientContext) => {
    remoteCtx.effect(() => remoteCtx.locale.register('agent-plugins', { zh, en }), 'ui-agent-plugins.locale')
    const t = remoteCtx.locale.bind('agent-plugins')
    remoteCtx.slots.inject('conversation.view', () => remoteCtx.slots.register({
      name: 'conversation.view', id: 'agent-plugins', order: 20, locale: 'agent-plugins', label: () => t('tab'),
      inject: (sessionId: SessionId): AgentPluginsViewInjected => ({
        active: () => remoteCtx.sessions.binding(sessionId) !== undefined,
        list: async () => {
          const result = await remoteCtx.remote.agentPlugin.list(sessionId)
          if (!result.ok) throw new Error(`agentPlugin.list failed: ${result.error.code}`)
          return result.value
        },
      }),
    }, AgentPluginsView))
  })
}
