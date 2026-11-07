import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { FileJournalStore, type StoreStage } from '../../src/role-dynamics/store.ts'
import { digest } from '../../src/role-dynamics/history.ts'
import { RoleDynamicsService } from '../../src/role-dynamics/service.ts'
import { fixture, operation } from './fixtures.ts'

const directories: string[] = []
function temporary() { const directory = mkdtempSync(join(tmpdir(), 'qqbot-dynamics-')); directories.push(directory); return directory }
afterEach(() => {
  for (const directory of directories.splice(0)) {
    const absolute = resolve(directory)
    if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('qqbot-dynamics-')) throw new Error('unsafe cleanup')
    rmSync(absolute, { recursive: true, force: true })
  }
})
describe('single-file versioned journal storage', () => {
  it.each(['temporary', 'rename'] as const)('%s failure leaves previous authority intact and removes orphan temp', stage => {
    const root = temporary(); let fault: StoreStage | undefined
    const store = new FileJournalStore(root, at => { if (fault === at) throw new Error(stage) })
    store.save('r', { old: 1 }, () => {})
    fault = stage; expect(() => store.save('r', { new: 2 }, () => {})).toThrow(stage)
    expect(store.load('r')).toEqual({ old: 1 })
    const role = readdirSync(join(root, 'roles'))[0]!
    expect(readdirSync(join(root, 'roles', role))).toEqual(['journal.json'])
  })
  it('post-rename acknowledgement failure is recoverable from authoritative new journal', () => {
    const root = temporary(); let failure = false
    const store = new FileJournalStore(root, stage => { if (failure && stage === 'directory-sync') throw new Error('ack failure') })
    store.save('r', { old: 1 }, () => {}); failure = true
    expect(() => store.save('r', { new: 2 }, () => {})).toThrow(/ack/)
    expect(store.load('r')).toEqual({ new: 2 })
  })
  it('checks epoch immediately before rename; no late authority or temp file survives', () => {
    const root = temporary(); let valid = true
    const store = new FileJournalStore(root, stage => { if (stage === 'rename') valid = false })
    expect(() => store.save('r', { value: 1 }, () => { if (!valid) throw new Error('stale') })).toThrow(/stale/)
    expect(store.load('r')).toBeUndefined()
    const role = readdirSync(join(root, 'roles'))[0]!
    expect(readdirSync(join(root, 'roles', role))).toEqual([])
  })
  it('corrupt JSON/checksum/version keeps original bytes and reports damage', () => {
    const root = temporary(); const store = new FileJournalStore(root)
    store.save('r', { value: 1 }, () => {})
    const role = readdirSync(join(root, 'roles'))[0]!; const file = join(root, 'roles', role, 'journal.json')
    for (const text of ['{broken', '{"version":9}', '{"version":1,"checksum":"wrong","journal":{}}']) {
      writeFileSync(file, text); expect(() => store.load('r')).toThrow(/损坏/); expect(readFileSync(file, 'utf8')).toBe(text)
    }
  })
  it('untrusted role/session names never become filesystem paths, no index is required', async () => {
    const root = temporary(); const store = new FileJournalStore(root)
    const f = fixture(); const target = { roleId: '../../CON:role', sessionId: '../../../session' }
    f.history.make(target.sessionId); f.configs.set(target.roleId, f.configs.get('r')); f.selected.set(target.sessionId, target.roleId)
    const service = new RoleDynamicsService({ ...f.options, store })
    const snapshot = (await service.readSnapshot(target))!
    await service.commit(target, operation(snapshot, service.createOwnerSource()))
    const names = readdirSync(join(root, 'roles')); expect(names).toHaveLength(1); expect(names[0]).toMatch(/^[a-f0-9]{64}$/)
    expect(readdirSync(join(root, 'roles', names[0]!))).toEqual(['journal.json'])
    const recovered = new RoleDynamicsService({ ...f.options, store })
    expect((await recovered.readSnapshot(target))!.values['好感']).toBe(31)
  })
  it('role deletion and restoration retain exact progress ownership, values and receipts', async () => {
    const root = temporary(); const store = new FileJournalStore(root); const f = fixture()
    const service = new RoleDynamicsService({ ...f.options, store }); const owner = service.createOwnerSource()
    const snapshot = (await service.readSnapshot(f.target))!; const op = operation(snapshot, owner)
    const committed = await service.commit(f.target, op)
    await service.detachRole('r', 'test-stamp')
    expect(store.load('r')).toBeUndefined(); await expect(service.readSnapshot(f.target)).rejects.toThrow(/回收/)
    await service.restoreRole('r', 'test-stamp')
    expect(await service.readSnapshot(f.target)).toEqual(committed.snapshot)
    expect(await service.commit(f.target, op)).toEqual(committed)
    expect(() => store.detach('r', '../bad', () => {})).toThrow(/标识/)
  })
  it('refuses path junctions on both reading and writing', () => {
    const root = temporary(); const outside = temporary(); const store = new FileJournalStore(root)
    symlinkSync(outside, join(root, 'roles'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => store.save('r', {}, () => {})).toThrow(/联接/)
    expect(() => store.load('r')).toThrow(/联接/)
    expect(readdirSync(outside)).toEqual([])
  })
  it('tampered semantic schema fails even when envelope checksum was recalculated', async () => {
    const root = temporary(); const store = new FileJournalStore(root); const f = fixture()
    const service = new RoleDynamicsService({ ...f.options, store }); await service.readSnapshot(f.target)
    const role = readdirSync(join(root, 'roles'))[0]!; const file = join(root, 'roles', role, 'journal.json')
    const envelope = JSON.parse(readFileSync(file, 'utf8'))
    envelope.journal.progress[0].records[0].snapshot.revision = -1; envelope.checksum = digest(envelope.journal)
    writeFileSync(file, JSON.stringify(envelope))
    await expect(service.readSnapshot(f.target)).rejects.toThrow(/损坏/)
    expect(existsSync(file)).toBe(true)
  })
})
