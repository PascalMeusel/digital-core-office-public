import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, backup } from 'node:sqlite'
import { createServer } from 'vite'
import { chromium, firefox, expect } from '../../time-tracking-system/node_modules/@playwright/test/index.mjs'
process.chdir(fileURLToPath(new URL('../', import.meta.url)))
const phase = process.argv.includes('--before') ? 'before' : 'after'
const directory = mkdtempSync(join(tmpdir(), 'dco-structure-')), root = resolve('../.runtime/inventory-structure-20261109'), output = resolve(`../artifacts/inventory-structure/${phase}`)
mkdirSync(root,{recursive:true}); mkdirSync(output,{recursive:true})
const dbPath = join(directory,'inventory.sqlite'), fixture = join(root,'comparison-fixture.sqlite'), webUrl='http://127.0.0.1:5213', apiUrl='http://127.0.0.1:5295/api/inventorySystem', password='L7!nRf4*Kw9#pUv8'
if (existsSync(fixture)) copyFileSync(fixture,dbPath)
writeFileSync(join(directory,'reference.json'),JSON.stringify({rooms:[{code:'LAB',name:'Labor',planImagePath:webUrl+'/test-plan.svg'}],locations:[],rows:[]}))
const api=spawn(process.execPath,['--import','tsx','server/index.ts'],{windowsHide:true,env:{...process.env,PORT:'5295',HOST:'127.0.0.1',CORS_ORIGIN:webUrl,DCO_CORE_URL:'',DISABLE_LOCAL_WEB_LOGIN:'false',INVENTORY_SYSTEM_DATA:dbPath,INVENTORY_MEDIA_DIR:join(directory,'media'),INVENTORY_REFERENCE_DATA_FILE:join(directory,'reference.json'),INVENTORY_SYSTEM_ADMIN_NAME:'Administrator Example',INVENTORY_SYSTEM_ADMIN_EMAIL:'administrator@example.test',INVENTORY_SYSTEM_ADMIN_PASSWORD:password}})
let log='';api.stdout.on('data',v=>log+=v);api.stderr.on('data',v=>log+=v)
const web=await createServer({server:{host:'127.0.0.1',port:5213,strictPort:true},define:{'import.meta.env.VITE_API_URL':JSON.stringify('http://127.0.0.1:5295'),'import.meta.env.VITE_ENABLED_MODULES':JSON.stringify('time,inventory')},plugins:[{name:'test-plan',configureServer(server){server.middlewares.use('/test-plan.svg',(_req,res)=>{res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500"><rect width="800" height="500" fill="#fafafa"/><path d="M20 20H780V480H20Z M400 20V480" fill="none" stroke="#333" stroke-width="5"/><text x="50" y="80" font-size="28">Labor</text><text x="460" y="80" font-size="28">Lager</text></svg>')})}}]})
let admin
async function call(path,body,session=admin){const response=await fetch(apiUrl+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(session?{Cookie:session.cookie,'x-inventory-csrf':session.csrf}:{})},body:body?JSON.stringify(body):undefined});const data=await response.json();assert(response.ok,`${path}: ${data.message}`);return {data,response}}
async function login(email){const {data,response}=await call('/auth/login',{email,password},null);return {cookie:response.headers.getSetCookie().find(c=>c.startsWith('inventory_session=')).split(';')[0],csrf:data.csrfToken}}
try {
 await web.listen();for(let i=0;i<60;i++){try{await fetch('http://127.0.0.1:5295/api/health');break}catch{if(i===59)throw Error(log);await new Promise(r=>setTimeout(r,150))}}
 admin=await login('administrator@example.test')
 if(!existsSync(fixture)){
  for(const [name,email,role] of [['Developer Example','developer','software_developer'],['Receiver Example','receiver','receiver']])await call('/users',{name,email:email+'@example.test',role,password,mustChangePassword:false})
  const sw=await login('developer@example.test'), project=(await call('/projects',{name:'DemoDevice',code:'DEMO',description:'Hardware und Materialien für DemoDevice.'})).data.projects[0]
  const place=(await call('/locations',{name:'Labor · Regal A',code:'LAB-A',kind:'room',roomCode:'LAB',roomName:'Labor',planImagePath:webUrl+'/test-plan.svg',highlightX:10,highlightY:20,highlightWidth:20,highlightHeight:20})).data.locations[0]
  const items=[]
  for(const [index,name] of ['DemoDevice ESP PCB','DemoDevice STM PCB','Sensorstripe','IMU','IMU Case','IMU-to-STM Kabel','Mattenmaterial','Sensorstripeset'].entries()){
   const sku=`DEMO-${index}`;const item=(await call('/items',{name,sku,unit:index===6?'m²':'pcs',category:'DemoDevice'})).data.items.find(i=>i.sku===sku);items.push(item)
   if([0,2,3].includes(index))await call('/records',{itemId:item.id,locationId:place.id,quantity:index===2?24:8,unitCost:4,state:'in_stock',condition:'new'})
  }
  await call('/workflows/products',{name:'Sensorstripeset',code:'DEMO-SET',revision:'1',outputItemId:items[7].id,parts:[{itemId:items[2].id,quantity:4},{itemId:items[3].id,quantity:1}]})
  await call('/workflows/requests/batch',{projectId:project.id,lines:[{itemId:items[1].id,quantity:3,estimatedUnitCost:12},{itemId:items[5].id,quantity:3,estimatedUnitCost:2}]},sw)
  const purchase=(await call('/workflows/requests',{projectId:project.id,kind:'purchase',itemId:items[2].id,quantity:16,estimatedUnitCost:4},sw)).data.workflows.requests[0]
  const approved=(await call(`/workflows/requests/${purchase.id}/review`,{expectedVersion:purchase.version,decision:'approve'})).data.workflows.requests.find(r=>r.id===purchase.id)
  await call('/workflows/orders',{supplier:'Elektroniklieferant',reference:'DEMO-2026-014',shipping:6,lines:[{requestId:approved.id,expectedVersion:approved.version,unitCost:4}]})
  await call('/workflows/requests',{kind:'stock',projectId:project.id,itemId:items[0].id,quantity:2,usage:'borrow'},sw)
  const db=new DatabaseSync(dbPath);try{await backup(db,fixture)}finally{db.close()}
 }
 const state=(await call('/state')).data, board=state.items.find(i=>i.name==='DemoDevice ESP PCB')
 const sessions={software:await login('developer@example.test'),receiver:await login('receiver@example.test'),admin}
 const checks=[]
 for(const [engineName,engine] of phase==='before'?[['chromium',chromium]]:[['chromium',chromium],['firefox',firefox]]){
  const browser=await engine.launch({headless:true}), errors=[]
  try{
   const pages={}
   for(const [role,session] of Object.entries(sessions)){
    const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addCookies([{name:'inventory_session',value:session.cookie.split('=')[1],url:'http://127.0.0.1'}]);await context.addInitScript(()=>{localStorage.setItem('digital-core-office.language','de');localStorage.setItem('digital-core-office.theme','light')})
    pages[role]=await context.newPage();pages[role].on('pageerror',e=>errors.push(e.message))
   }
   const sw=pages.software, receiver=pages.receiver, buyer=pages.admin
   async function shot(page,name){if(engineName==='chromium'){await page.mouse.move(0,0);await page.screenshot({path:join(output,name+'.png'),animations:'disabled'})}}
   await sw.goto(webUrl+'/projects');await expect(sw.locator('.project-parts')).toBeVisible();await shot(sw,'project-desktop')
   await sw.getByRole('button',{name:'Teile anfragen',exact:true}).click();await expect(sw.locator('.inventory-workflow-editor')).toBeVisible();await shot(sw,'request-desktop')
   await sw.locator('.inventory-workflow-editor').getByRole('button',{name:'Abbrechen',exact:true}).click()
   if(phase==='after'){
    await sw.getByRole('tab',{name:'Anfragen',exact:true}).click();await expect(sw.locator('[data-batch-id]')).toBeVisible()
    await sw.getByRole('tab',{name:'Kosten',exact:true}).click();await expect(sw.locator('.workflow-totals')).toBeVisible()
    await sw.getByRole('tab',{name:'Teile',exact:true}).click();await expect(sw.locator('.workflow-totals')).not.toBeVisible()
    await sw.keyboard.press('ArrowRight');await expect(sw.getByRole('tab',{name:'Anfragen',exact:true})).toBeFocused()
    await sw.keyboard.press('End');await expect(sw.getByRole('tab',{name:'Zuweisungen',exact:true})).toBeFocused()
    await sw.keyboard.press('Home');await expect(sw.getByRole('tab',{name:'Teile',exact:true})).toBeFocused()
    assert.equal(await sw.locator('.project-parts thead').innerText().then(t=>t.includes('Frei im Büro')),true)
   }
   await sw.getByLabel('Projektteile suchen',{exact:true}).fill(board.name)
   await sw.locator('.project-parts').getByRole('button',{name:'Bestand anfragen',exact:true}).click()
   const form=sw.locator('.inventory-workflow-editor');await expect(form).toBeVisible()
   if(phase==='after'){
    const dialog=sw.getByRole('dialog');await expect(dialog).toBeVisible()
    await form.getByLabel('Menge',{exact:true}).fill('3');await sw.keyboard.press('Escape');await expect(dialog).toBeVisible();await expect(form.getByLabel('Menge',{exact:true})).toHaveValue('3')
    // A conflict can reveal revoked access while an editor is open. The modal
    // must release the recovery UI without unmounting the entered draft.
    const headers={'access-control-allow-origin':webUrl,'access-control-allow-credentials':'true'}
    await sw.route('**/api/inventorySystem/workflows/requests',route=>route.fulfill({status:409,headers,json:{message:'Synthetic conflict'}}),{times:1})
    await sw.route('**/api/inventorySystem/state',route=>route.fulfill({status:403,headers,json:{message:'Synthetic revoked access'}}),{times:1})
    await form.getByRole('button',{name:'Anfrage senden',exact:true}).click()
    await expect(sw.getByRole('heading',{name:'Zugriff auf Inventar nicht verfügbar',exact:true})).toBeVisible()
    await expect(dialog).not.toBeVisible()
    await sw.getByRole('button',{name:'Erneut versuchen',exact:true}).click()
    await expect(dialog).toBeVisible();await expect(form.getByLabel('Menge',{exact:true})).toHaveValue('3')
    await form.getByRole('button',{name:'Abbrechen',exact:true}).click();await expect(dialog).toHaveCount(0)
    await expect(sw.locator('.project-parts').getByRole('button',{name:'Bestand anfragen',exact:true})).toBeFocused()
   }else await form.getByRole('button',{name:'Abbrechen',exact:true}).click()
   await sw.getByLabel('Projektteile suchen',{exact:true}).fill('')
   await buyer.goto(webUrl+'/overview');await expect(buyer.locator('#workflow-approvals')).toBeVisible();await shot(buyer,'approval-desktop')
   await receiver.goto(webUrl+'/overview');await expect(receiver.getByRole('button',{name:'Lieferung einbuchen',exact:true})).toBeVisible();await shot(receiver,'receiving-home')
   await receiver.setViewportSize({width:390,height:844});await receiver.getByRole('button',{name:'Lieferung einbuchen',exact:true}).click()
   await receiver.locator('.inventory-workflow-editor').locator('.workflow-row').filter({hasText:'DEMO-2026-014'}).getByRole('button',{name:'Bestellung auswählen'}).click();await expect(receiver.locator('.inventory-workflow-editor').getByLabel('Lagerort',{exact:true})).toBeVisible();await shot(receiver,'receiving-mobile')
   for(const width of [390,1440])for(const theme of ['light','dark']){
    await sw.setViewportSize({width,height:width===390?844:1000});await sw.evaluate(theme=>{localStorage.setItem('digital-core-office.theme',theme);dispatchEvent(new StorageEvent('storage',{key:'digital-core-office.theme',newValue:theme}))},theme)
    await expect.poll(()=>sw.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
    await sw.mouse.move(0,0)
    await expect(sw.getByLabel('Projektübersicht',{exact:true}).first()).toHaveCSS('background-color',theme==='dark'?'rgb(16, 26, 40)':'rgb(255, 255, 255)')
    await shot(sw,`project-${width}-${theme}`)
    if(phase==='after'){
     await sw.getByRole('button',{name:'Teile anfragen',exact:true}).click();const panel=sw.getByRole('dialog');await expect(panel).toBeVisible();await expect(panel.locator('.primary-action')).toBeEnabled()
     await sw.keyboard.press('Shift+Tab');assert(await panel.evaluate(el=>el.contains(document.activeElement)),'Focus stays inside dialog')
     await panel.getByRole('button',{name:'Abbrechen',exact:true}).click()
     if(width===390){await sw.locator('.inventory-mobile-navigation summary').click();await expect(sw.locator('.inventory-mobile-navigation')).toContainText('Orte & Raumplan');await sw.locator('.inventory-mobile-navigation summary').click()}
    }
   }
   await sw.goto(webUrl+'/inventory');await sw.getByLabel('Bestand suchen',{exact:true}).fill('ESP');await sw.locator('.workflow-stock-item summary').click();await shot(sw,'stock-desktop')
   if(phase==='after'){
    await sw.getByRole('button',{name:'Produkte & Stücklisten',exact:true}).click();await expect(sw.getByRole('heading',{name:'Produkte, die wir bauen'})).toBeVisible()
    await sw.goto(webUrl+'/locations');await expect(sw.locator('.inventory-content')).toContainText('Labor')
    await sw.goto(webUrl+'/requests');await expect(sw.getByRole('heading',{name:'Anfragen',exact:true})).toBeVisible()
    await sw.getByLabel('Anfragen suchen',{exact:true}).fill('IMU-to-STM');await expect(sw.locator('.workflow-request-batch .workflow-row')).toHaveCount(2)
    await sw.goto(webUrl+'/projects');await sw.getByLabel('Projektübersicht',{exact:true}).first().selectOption('');await sw.getByRole('button',{name:'Teile anfragen',exact:true}).click();await expect(sw.locator('.inventory-workflow-editor')).toContainText('Allgemeiner Bedarf')
   }
   assert.deepEqual(errors,[]);checks.push({browser:engineName,phase,matchedFixture:true,roleScreens:true,projectTabs:phase==='after',responsiveThemes:true,dialogFocusAndDraft:phase==='after',generalSupplies:phase==='after'})
  }catch(error){for(const page of browser.contexts().flatMap(c=>c.pages()))await page.screenshot({path:join(output,`failure-${engineName}-${browser.contexts().flatMap(c=>c.pages()).indexOf(page)}.png`)}).catch(()=>{});throw error}finally{await browser.close()}
 }
 writeFileSync(join(output,'verification.json'),JSON.stringify(checks,null,2));console.log(JSON.stringify(checks))
}finally{await web.close();api.kill();await new Promise(r=>api.exitCode!==null?r():api.once('exit',r));assert.equal(dirname(resolve(directory)),resolve(tmpdir()));rmSync(directory,{recursive:true,force:true})}
