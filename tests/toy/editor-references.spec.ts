import {it,expect} from 'vitest'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ToyHost} from '../../src/toy/index.ts'
it('同步提交前现读角色引用，拒绝改名删除，释放引用后可保存',()=>{
 const host=new ToyHost(mkdtempSync(join(tmpdir(),'editor-ref-')),()=>{})
 const original=host.actionLibrary.value
 const target=original.library.clips[0]!
 let refs: readonly string[]=[target.name]
 const unregister=host.register({extension:()=>()=>{},runtime:()=>()=>{},content:{roles:{list:()=>[{name:'测试角色',motionActions:refs}]}}})
 const next={...original,library:{...original.library,clips:original.library.clips.map(c=>c.id===target.id?{...c,name:'修改名称'}:c)},pools:Object.fromEntries(Object.entries(original.pools).map(([k,p])=>[k,p.map(e=>e.name===target.name?{...e,name:'修改名称'}:e)]))}
 expect(()=>host.apply({action:'library.save',library:next})).toThrow('测试角色')
 expect(host.actionLibrary.value).toEqual(original)
 refs=[];expect(()=>host.apply({action:'library.save',library:next})).not.toThrow()
 unregister();host.dispose()
})
