import { clientBundle } from '../tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-client-ui-markdown-images',
  ['lib/types/index.js', 'lib/types/invariant.js'],
  { hostPhase: true },
)
