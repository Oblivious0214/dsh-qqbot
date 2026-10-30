import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { UiExtensions, UiExtensionsService, type UiExtensionProps } from '../src/client/ui-extensions.tsx'

describe('optional UI settings', () => {
  it('removes registered settings when the provider is disabled', async () => {
    const root = new Context()
    const extensions = new UiExtensions()
    const service = await root.plugin(UiExtensionsService, extensions)
    const Component = () => null
    const consumer = await root.plugin({
      name: 'toy-test', inject: ['qqbotUi'],
      apply(ctx: Context) {
        const ui = (ctx as unknown as { qqbotUi: { register(component: ComponentType<UiExtensionProps>): () => void } }).qqbotUi
        ui.register(Component)
      },
    })
    expect(extensions.getSnapshot()).toEqual([Component])
    await consumer.dispose()
    expect(extensions.getSnapshot()).toEqual([])
    await service.dispose()
  })
})
