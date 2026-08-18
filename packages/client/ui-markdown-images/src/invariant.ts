/** Package-owned invariant companion for the Markdown image resolver plugin. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-markdown-images'

/** Cordis companion plugin name. */
export const name = 'client-ui-markdown-images-invariant'
/** Service required before reserving package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: registration ownership is enforced by Connection and
 * sessions.provide.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns installed registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
