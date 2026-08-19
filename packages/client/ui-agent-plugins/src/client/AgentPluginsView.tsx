import { useEffect, useState, type ReactNode } from 'react'
import type { AgentPluginSnapshot, AgentPluginStatus } from '@deepseek-ai/dsh-agent-plugins/types'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentPluginsLocaleKey } from './locales.ts'
import css from './AgentPluginsView.module.css'

/** Session-bound inventory operations supplied by the conversation view. */
export interface AgentPluginsViewInjected {
  active: () => boolean
  list: () => Promise<AgentPluginSnapshot>
}

export type AgentPluginsViewProps = ConvViewProps & InjectFace<AgentPluginsViewInjected> & PropsLocale<'agent-plugins'>
type State =
  | { status: 'inactive' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; snapshot: AgentPluginSnapshot }
const statusKey = { loaded: 'loaded', partial: 'partial', failed: 'failed' } as const satisfies Record<AgentPluginStatus, AgentPluginsLocaleKey>

/** Render one selected agent's flat compatibility inventory. */
export function AgentPluginsView({ active, list, t }: AgentPluginsViewProps): ReactNode {
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<State>(() => active() ? { status: 'loading' } : { status: 'inactive' })
  useEffect(() => {
    if (!active()) { setState({ status: 'inactive' }); return }
    let current = true
    setState({ status: 'loading' })
    void list().then(
      (snapshot) => { if (current) setState({ status: 'ready', snapshot }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [active, list, request])
  const refresh = (): void => { setRequest(value => value + 1) }
  if (state.status === 'inactive') return <p className={css.state}>{t('inactive')}</p>
  if (state.status === 'loading') return <p className={css.state} aria-busy="true">{t('loading')}</p>
  if (state.status === 'error') return <div className={css.state}><p role="alert">{t('error')}</p><button type="button" onClick={refresh}>{t('refresh')}</button></div>
  return <section className={css.view} aria-label={t('tab')}>
    <header><h2>{t('tab')}</h2><button type="button" onClick={refresh}>{t('refresh')}</button></header>
    {state.snapshot.entries.length === 0 ? <p className={css.state}>{t('empty')}</p> : <ul>
      {state.snapshot.entries.map(entry => <li key={entry.qualifiedId} data-status={entry.status}>
        <div className={css.summary}>
          <strong>{entry.name}</strong><span>{entry.source}</span><span>{entry.format}</span>
          <span>{t(statusKey[entry.status])}</span>
        </div>
        <p>{entry.skillCount} {t('skills')} · {entry.commandCount} {t('commands')} · {entry.mcpServerCount} {t('mcpServers')}</p>
        {entry.version === undefined ? null : <p>{entry.version}</p>}
        {entry.error === undefined ? null : <p className={css.error}>{entry.error}</p>}
      </li>)}
    </ul>}
  </section>
}
