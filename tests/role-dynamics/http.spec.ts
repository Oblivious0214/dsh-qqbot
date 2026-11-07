import { expect, it } from 'vitest'
import { auditStateHttp } from './http-audit.ts'
it('real HTTP exact route: host owner identity, CAS, replay and cleanup epoch', async () => {
  const result = await auditStateHttp()
  expect(result.checks).toHaveLength(9); expect(result.errors).toEqual([])
}, 15000)
