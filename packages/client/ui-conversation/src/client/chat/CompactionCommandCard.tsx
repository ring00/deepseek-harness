// CompactionCommandCard: the `/compact` command's running row and its
// successful checkpoint disclosure. Outcomes without a checkpoint keep the
// generic command card so no-history, cancellation, and failures retain their
// complete handler-authored text.

import type { ChatViewSlotProps, CommandRowOwnerProps } from '../contract/slots.ts'
import type { MarkdownImageResolver } from '@deepseek-ai/dsh-client-ui-primitives'
import { CompactionItem } from './CompactionItem.tsx'
import { GenericCommandCard } from './GenericCommandCard.tsx'

interface CompactionCommandCardProps extends CommandRowOwnerProps {
  t: ChatViewSlotProps['t']
  imageResolver?: MarkdownImageResolver | undefined
  imageOwner: string
}

/** Render one manual compaction lifecycle without duplicating its checkpoint marker. */
export function CompactionCommandCard({ node, compaction, imageResolver, imageOwner, t }: CompactionCommandCardProps) {
  if (compaction !== undefined) {
    return (
      <CompactionItem
        node={compaction}
        title="compact"
        fallbackSummary={node.outcome?.text ?? null}
        imageResolver={imageResolver}
        imageOwner={imageOwner}
        t={t}
      />
    )
  }
  if (node.outcome !== null) return <GenericCommandCard node={node} t={t} />
  return <GenericCommandCard node={node} t={t} runningSummary={t('message.compaction.running')} />
}
