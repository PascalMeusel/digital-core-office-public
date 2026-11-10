import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium, firefox, expect } from '../../time-tracking-system/node_modules/@playwright/test/index.mjs'
process.chdir(fileURLToPath(new URL('../', import.meta.url)))
const directory=mkdtempSync(join(tmpdir(),'dco-request-entry-')), output=resolve('../artifacts/inventory-request-entry'), webUrl='http://127.0.0.1:5217', apiUrl='http://127.0.0.1:5299/api/inventorySystem', password='L7!nRf4*Kw9#pUv8'
mkdirSync(output,{recursive:true})
const api=spawn(process.execPath,['--import','tsx','server/index.ts'],{windowsHide:true,env:{...process.env,PORT:'5299',HOST:'127.0.0.1',CORS_ORIGIN:webUrl,DCO_CORE_URL:'',DISABLE_LOCAL_WEB_LOGIN:'false',INVENTORY_SYSTEM_DATA:join(directory,'inventory.sqlite'),INVENTORY_REFERENCE_DATA_FILE:join(directory,'absent.json'),INVENTORY_SYSTEM_ADMIN_EMAIL:'administrator@example.test',INVENTORY_SYSTEM_ADMIN_PASSWORD:password}})
let log='';api.stdout.on('data',v=>log+=v);api.stderr.on('data',v=>log+=v)
const web=await createServer({server:{host:'127.0.0.1',port:5217,strictPort:true},define:{'import.meta.env.VITE_API_URL':JSON.stringify('http://127.0.0.1:5299'),'import.meta.env.VITE_ENABLED_MODULES':JSON.stringify('time,inventory')}})
let admin
async function call(path,body,session=admin){const response=await fetch(apiUrl+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(session?{Cookie:session.cookie,'x-inventory-csrf':session.csrf}:{})},body:body?JSON.stringify(body):undefined});const data=await response.json();assert(response.ok,`${path}: ${data.message}`);return {data,response}}
async function login(email){const {data,response}=await call('/auth/login',{email,password},null);return {cookie:response.headers.getSetCookie().find(c=>c.startsWith('inventory_session=')).split(';')[0],csrf:data.csrfToken}}
try {
 await web.listen();for(let i=0;i<60;i++){try{await fetch('http://127.0.0.1:5299/api/health');break}catch{if(i===59)throw Error(log);await new Promise(r=>setTimeout(r,150))}}
 admin=await login('administrator@example.test')
 await call('/users',{name:'Developer Example',email:'developer@example.test',role:'software_developer',password,mustChangePassword:false})
 const software=await login('developer@example.test')
 const project=(await call('/projects',{name:'DemoDevice',code:'DEMO'})).data.projects.find(p=>p.code==='DEMO')
 await call('/catalog/import',{idempotencyKey:crypto.randomUUID(),rows:Array.from({length:90},(_,i)=>({name:`Existing part ${String(i+1).padStart(3,'0')}`,sku:`ENTRY-${i+1}`,unit:'pcs',projectIds:[project.id]}))})
 const results=[]
 for(const [engineName,engine] of [['chromium',chromium],['firefox',firefox]]){
  const browser=await engine.launch({headless:true}), errors=[]
  try {
   const context=await browser.newContext({viewport:{width:390,height:844}})
   await context.addCookies([{name:'inventory_session',value:software.cookie.split('=')[1],url:'http://127.0.0.1'}])
   await context.addInitScript(()=>{localStorage.setItem('digital-core-office.language','de');localStorage.setItem('digital-core-office.theme','light')})
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message))
   await page.goto(webUrl+'/projects');await page.getByRole('button',{name:'Teile anfragen',exact:true}).click()
   const dialog=page.getByRole('dialog'), entry=dialog.locator('.purchase-new-part summary')
   await expect(entry).toBeInViewport();await expect(dialog.locator('.purchase-parts .purchase-part')).toHaveCount(90)
   await page.screenshot({path:join(output,engineName+'-mobile-entry.png'),animations:'disabled'})
   await entry.click();await dialog.getByLabel('Name des neuen Teils',{exact:true}).fill('New DEMO sensor '+engineName)
   await dialog.getByLabel('Menge des neuen Teils',{exact:true}).fill('2.5');await dialog.getByLabel('Einheit des neuen Teils',{exact:true}).selectOption('m²')
   await dialog.getByLabel('Lieferantenlink für neues Teil (optional)',{exact:true}).fill('https://example.com/new-demo')
   await page.keyboard.press('Escape');await expect(dialog).toBeVisible();await expect(dialog.getByLabel('Name des neuen Teils',{exact:true})).toHaveValue('New DEMO sensor '+engineName)
   await page.screenshot({path:join(output,engineName+'-mobile-new-part.png'),animations:'disabled'})
   await dialog.getByRole('button',{name:'Zur Freigabe senden',exact:true}).click();await expect(dialog).toHaveCount(0)
   let state=(await call('/state')).data, sent=state.workflows.requests.find(r=>r.itemName==='New DEMO sensor '+engineName)
   assert.equal(sent.itemId,undefined);assert.equal(sent.quantity,2.5);assert.equal(sent.unit,'m²');assert.equal(sent.supplierUrl,'https://example.com/new-demo');assert.equal(sent.projectId,project.id)
   assert(!state.items.some(i=>i.name===sent.itemName),'Software request does not create a catalog article or grant catalog privileges')
   // Keep selected parts and their links first even after another search and a full catalog.
   await page.getByRole('button',{name:'Teile anfragen',exact:true}).click()
   const middleQuantity=dialog.getByLabel('Menge · Existing part 070',{exact:true})
   await middleQuantity.scrollIntoViewIfNeeded();await middleQuantity.pressSequentially('12');await expect(middleQuantity).toHaveValue('12');await expect(middleQuantity).toBeFocused();await middleQuantity.fill('')
   await dialog.getByLabel('Teile suchen',{exact:true}).fill('Existing part 090')
   const quantity=dialog.getByLabel('Menge · Existing part 090',{exact:true})
   await quantity.pressSequentially('12');await expect(quantity).toHaveValue('12');await expect(quantity).toBeFocused()
   await dialog.getByLabel('Teile suchen',{exact:true}).fill('')
   await expect(dialog.locator('.purchase-part').first()).toContainText('Existing part 090')
   await expect(dialog.getByLabel('Lieferantenlink · Existing part 090',{exact:true})).toBeVisible()
   await entry.click();await dialog.getByLabel('Name des neuen Teils',{exact:true}).fill('Additional PCB '+engineName)
   await dialog.getByLabel('Lieferantenlink für neues Teil (optional)',{exact:true}).fill('https://example.com/pcb')
   await dialog.getByRole('button',{name:'Zur Anfrage hinzufügen',exact:true}).click()
   await expect(dialog.getByLabel('Name des neuen Teils',{exact:true})).toHaveValue('')
   await expect(dialog.locator('.purchase-part').nth(1)).toContainText('Additional PCB '+engineName)
   await expect(dialog.getByLabel('Lieferantenlink · Additional PCB '+engineName,{exact:true})).toHaveValue('https://example.com/pcb')
   await dialog.getByRole('button',{name:'Zur Freigabe senden',exact:true}).click();await expect(dialog).toHaveCount(0)
   state=(await call('/state')).data;const added=state.workflows.requests.find(r=>r.itemName==='Additional PCB '+engineName), batch=state.workflows.requests.filter(r=>r.batchId===added.batchId)
   assert.equal(batch.length,2);assert.equal(batch.find(r=>r.itemName==='Existing part 090').quantity,12)
   // The no-result action also belongs above the list, and the same entry is reachable from Requests.
   await page.goto(webUrl+'/requests');await page.getByRole('button',{name:'Mehrere Teile anfragen',exact:true}).click();await expect(entry).toBeInViewport()
   await dialog.getByLabel('Teile suchen',{exact:true}).fill('Different brand new part')
   const searchAction=dialog.getByRole('button',{name:'Als neuen Artikel anfragen: Different brand new part',exact:true})
   const actionBox=await searchAction.boundingBox(), listBox=await dialog.locator('.purchase-parts').boundingBox();assert(actionBox.y<listBox.y)
   await entry.click();await dialog.getByLabel('Name des neuen Teils',{exact:true}).fill('Keep this draft')
   await dialog.getByLabel('Lieferantenlink für neues Teil (optional)',{exact:true}).fill('https://example.com/keep')
   await searchAction.click();await expect(dialog.getByLabel('Name des neuen Teils',{exact:true})).toHaveValue('Keep this draft');await expect(dialog.getByLabel('Lieferantenlink für neues Teil (optional)',{exact:true})).toHaveValue('https://example.com/keep')
   await dialog.getByRole('button',{name:'Abbrechen',exact:true}).click()
   for(const width of [390,1440])for(const theme of ['light','dark']){
    await page.setViewportSize({width,height:width===390?844:1000});await page.evaluate(theme=>{localStorage.setItem('digital-core-office.theme',theme);dispatchEvent(new StorageEvent('storage',{key:'digital-core-office.theme',newValue:theme}))},theme)
    await page.getByRole('button',{name:'Mehrere Teile anfragen',exact:true}).click();await expect(entry).toBeInViewport();await entry.click()
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
    await expect(dialog.getByLabel('Name des neuen Teils',{exact:true})).toHaveCSS('background-color',theme==='dark'?'rgb(16, 26, 40)':'rgb(255, 255, 255)')
    await page.screenshot({path:join(output,`${engineName}-${width}-${theme}.png`),animations:'disabled'})
    await dialog.getByRole('button',{name:'Abbrechen',exact:true}).click()
   }
   assert.deepEqual(errors,[]);results.push({browser:engineName,role:'software_developer',catalogSize:90,entryInitiallyVisible:true,directNewPart:true,mixedBatch:true,selectedFirst:true,keyboardQuantity:true,mobileAndThemes:true})
  }catch(error){for(const [i,p] of browser.contexts().flatMap(c=>c.pages()).entries())await p.screenshot({path:join(output,engineName+'-failure-'+i+'.png'),fullPage:true}).catch(()=>{});throw error}finally{await browser.close()}
 }
 writeFileSync(join(output,'verification.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results))
}finally{await web.close();api.kill();await new Promise(r=>api.exitCode!==null?r():api.once('exit',r));assert.equal(dirname(resolve(directory)),resolve(tmpdir()));rmSync(directory,{recursive:true,force:true})}
