import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('workspace APIs verify current Core identity, provision new users and reject stale, revoked and read-only access', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'dco-agile-api-'))
  process.env.AGILE_PROJECT_DATA = join(temp, 'agile.sqlite')
  process.env.DCO_INTERNAL_AUTH_SECRET = 'isolated-test-secret'
  process.env.AGILE_INITIAL_ADMIN_PASSWORD = ''
  let revoked = false
  const introspected: string[] = []
  const core = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    const input = JSON.parse(body || '{}') as {token?:string;moduleId?:string;write?:boolean}
    response.setHeader('Content-Type','application/json')
    assert.equal(request.headers['x-dco-internal-secret'],'isolated-test-secret')
    if (!input.token || revoked || !['admin-token','employee-token','viewer-token'].includes(input.token)) {
      response.writeHead(401); response.end(JSON.stringify({message:'Session revoked.'})); return
    }
    introspected.push(input.token)
    assert.equal(input.moduleId,'agile')
    const role = input.token === 'admin-token' ? 'admin' : 'employee'
    const viewer = input.token === 'viewer-token'
    if (viewer && input.write) {response.writeHead(403);response.end(JSON.stringify({message:'Read-only membership.'}));return}
    response.end(JSON.stringify({user:{id:input.token,name:input.token,email:`${input.token}@example.invalid`,role,active:true,mustChangePassword:false,moduleRole:viewer?'viewer':role,readOnly:viewer}}))
  })
  core.listen(0,'127.0.0.1'); await once(core,'listening')
  process.env.DCO_CORE_URL = `http://127.0.0.1:${(core.address() as {port:number}).port}`
  const {app} = await import('../server/index.ts')
  const server = app.listen(0,'127.0.0.1'); await once(server,'listening')
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`
  try {
    const {upsertCoreProfile,connection} = await import('../server/userbase.ts')
    const profileA = upsertCoreProfile({id:'core-a',email:'reused@example.invalid',name:'A',moduleRole:'admin',mustChangePassword:false})
    const profileB = upsertCoreProfile({id:'core-b',email:'reused@example.invalid',name:'B',moduleRole:'employee',mustChangePassword:false})
    assert.notEqual(profileB.id,profileA.id)
    assert.equal((connection().prepare('SELECT coreUserId FROM agile_users WHERE id=?').get(profileA.id) as {coreUserId:string}).coreUserId,'core-a')
    assert.equal(upsertCoreProfile({id:'core-a',email:'renamed@example.invalid',name:'A renamed',moduleRole:'employee',mustChangePassword:false}).id,profileA.id)
    const sso = await fetch(`${base}/api/agile/auth/sso-session`,{headers:{Cookie:'dco_core_session=admin-token'}})
    assert.equal(sso.headers.get('cache-control'),'no-store')
    const ssoBody = await sso.json()
    assert.equal(ssoBody.token,'');assert.equal(ssoBody.sessionToken,undefined)
    assert.equal((await fetch(`${base}/api/agile/workspace`)).status,401)
    const first = await fetch(`${base}/api/agile/workspace`,{headers:{Cookie:'dco_core_session=admin-token'}})
    assert.equal(first.status,200); assert.equal((await first.json()).permissions.approveDecisions,true)
    const switched = await fetch(`${base}/api/agile/workspace`,{headers:{Cookie:'dco_core_session=employee-token',Authorization:'Bearer admin-token'}})
    assert.equal(switched.status,200); assert.equal((await switched.json()).permissions.approveDecisions,false)
    assert.equal(introspected.at(-1),'employee-token')
    const forgedApproval = await fetch(`${base}/api/agile/workspace/commands`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:'dco_core_session=employee-token'},body:JSON.stringify({requestId:'forged-approval',revision:0,operation:{type:'update_decision',id:'missing',status:'Accepted'}})})
    assert.equal(forgedApproval.status,403)
    const viewer = await fetch(`${base}/api/agile/workspace`,{headers:{Cookie:'dco_core_session=viewer-token'}})
    assert.equal(viewer.status,200); assert.equal((await viewer.json()).permissions.editWork,false)
    const viewerWrite = await fetch(`${base}/api/agile/workspace/commands`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:'dco_core_session=viewer-token'},body:'{}'})
    assert.equal(viewerWrite.status,403)
    revoked = true
    assert.equal((await fetch(`${base}/api/agile/workspace/export`,{headers:{Cookie:'dco_core_session=admin-token'}})).status,401)
    assert.equal((await fetch(`${base}/api/agile/auth/session`,{headers:{Authorization:'Bearer admin-token'}})).status,401)
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()))
    await new Promise<void>(resolve=>core.close(()=>resolve()))
    // The module connection lives until this isolated test worker exits.
  }
})
