import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium, firefox, expect } from '../../time-tracking-system/node_modules/@playwright/test/index.mjs'
process.chdir(fileURLToPath(new URL('../', import.meta.url)))
const directory=mkdtempSync(join(tmpdir(),'dco-catalog-browser-')), output=resolve('../artifacts/inventory-feedback'), webUrl='http://127.0.0.1:5216', apiUrl='http://127.0.0.1:5298/api/inventorySystem', password='L7!nRf4*Kw9#pUv8'
mkdirSync(output,{recursive:true})
const api=spawn(process.execPath,['--import','tsx','server/index.ts'],{windowsHide:true,env:{...process.env,PORT:'5298',HOST:'127.0.0.1',CORS_ORIGIN:webUrl,DCO_CORE_URL:'',DISABLE_LOCAL_WEB_LOGIN:'false',INVENTORY_SYSTEM_DATA:join(directory,'inventory.sqlite'),INVENTORY_REFERENCE_DATA_FILE:join(directory,'absent.json'),INVENTORY_SYSTEM_ADMIN_EMAIL:'administrator@example.test',INVENTORY_SYSTEM_ADMIN_PASSWORD:password}})
let log='';api.stdout.on('data',v=>log+=v);api.stderr.on('data',v=>log+=v)
const web=await createServer({server:{host:'127.0.0.1',port:5216,strictPort:true},define:{'import.meta.env.VITE_API_URL':JSON.stringify('http://127.0.0.1:5298'),'import.meta.env.VITE_ENABLED_MODULES':JSON.stringify('time,inventory')}})
let admin
async function call(path,body,session=admin){const response=await fetch(apiUrl+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(session?{Cookie:session.cookie,'x-inventory-csrf':session.csrf}:{})},body:body?JSON.stringify(body):undefined});const data=await response.json();assert(response.ok,`${path}: ${data.message}`);return {data,response}}
async function login(email){const {data,response}=await call('/auth/login',{email,password},null);return {cookie:response.headers.getSetCookie().find(c=>c.startsWith('inventory_session=')).split(';')[0],csrf:data.csrfToken}}
try {
 await web.listen();for(let i=0;i<60;i++){try{await fetch('http://127.0.0.1:5298/api/health');break}catch{if(i===59)throw Error(log);await new Promise(r=>setTimeout(r,150))}}
 admin=await login('administrator@example.test')
 await call('/users',{name:'Developer Example',email:'developer@example.test',role:'software_developer',password,mustChangePassword:false})
 const software=await login('developer@example.test')
 for(const name of ['DemoStorage','DemoAccess'])await call('/projects',{name,code:name.toUpperCase()})
 const results=[]
 for(const [engineName,engine] of [['chromium',chromium],['firefox',firefox]]){
  const browser=await engine.launch({headless:true}), errors=[]
  try{
   async function pageFor(session){const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addCookies([{name:'inventory_session',value:session.cookie.split('=')[1],url:'http://127.0.0.1'}]);await context.addInitScript(()=>{localStorage.setItem('digital-core-office.language','de');localStorage.setItem('digital-core-office.theme','light')});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));return page}
   const page=await pageFor(admin), name='Schraube M3×8 '+engineName
   await page.goto(webUrl+'/catalog');await page.getByRole('button',{name:'Neuer Artikel',exact:true}).click()
   await page.getByLabel('Name',{exact:true}).fill(name);await page.getByLabel('SKU optional').fill('M3-'+engineName);await page.getByLabel('Neue Kategorie',{exact:true}).fill('Mechanik')
   await page.getByLabel('Einheit',{exact:true}).selectOption('pcs');await page.getByLabel('Richtpreis je Einheit (EUR)',{exact:true}).fill('0,0125')
   await page.getByLabel('Artikellink (optional)',{exact:true}).fill('https://example.com/m3')
   await page.getByLabel('DEMOSTORAGE · DemoStorage',{exact:true}).check();await page.getByLabel('DEMOACCESS · DemoAccess',{exact:true}).check()
   await page.getByLabel('Bild auswählen',{exact:true}).setInputFiles({name:'screw.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAI0lEQVR4nGNkqMhjIAUwkaSaYVQDcYCJSHVwMKqBGEByKAEA8lQBBv9ZpNAAAAAASUVORK5CYII=','base64')})
   await expect(page.getByAltText('Fotovorschau')).toBeVisible()
   await page.setViewportSize({width:390,height:844});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
   await page.screenshot({path:join(output,engineName+'-article-mobile.png'),fullPage:true,animations:'disabled'})
   await page.getByRole('button',{name:'Artikel anlegen',exact:true}).click();await expect(page.getByRole('button',{name:name+' - Für Details anklicken',exact:true})).toBeVisible().catch(async()=>expect(page.locator('.catalog-card').filter({hasText:name})).toBeVisible())
   await page.locator('.catalog-card').filter({hasText:name}).click();await expect(page.locator('.record-detail-hero img')).toBeVisible();await expect.poll(()=>page.locator('.record-detail-hero img').evaluate(img=>img.naturalWidth)).toBeGreaterThan(0)
   await page.locator('.catalog-history summary').click();await expect(page.locator('.catalog-history')).toContainText('Artikel angelegt')
   await page.goto(webUrl+'/catalog');await page.getByRole('button',{name:'Teileliste importieren',exact:true}).click();const dialog=page.getByRole('dialog')
   await dialog.getByLabel('Liste einfügen',{exact:true}).fill(`Name;SKU;Einheit;Preis EUR\nImport A ${engineName};IMP-${engineName};pcs;1,20\nInvalid;BAD-${engineName};();0`)
   await dialog.getByRole('button',{name:'Vorschau prüfen'}).click();await expect(dialog.getByRole('button',{name:'Neue Artikel importieren'})).toBeDisabled()
   await dialog.getByLabel('Liste einfügen',{exact:true}).fill(`Name;SKU;Einheit;Preis EUR\nImport A ${engineName};IMP-${engineName};pcs;1,20`)
   await dialog.getByRole('button',{name:'Vorschau prüfen'}).click();await expect(dialog.getByRole('button',{name:'Neue Artikel importieren'})).toBeEnabled();await dialog.getByRole('button',{name:'Neue Artikel importieren'}).click();await expect(dialog).toHaveCount(0)
   await page.getByRole('button',{name:'Artikel Projekten zuordnen'}).click();await dialog.getByLabel('Artikel suchen',{exact:true}).fill('Import A '+engineName);await dialog.locator('.catalog-article-picker input').check();await dialog.getByLabel('DEMOSTORAGE · DemoStorage',{exact:true}).check();await dialog.getByLabel('DEMOACCESS · DemoAccess',{exact:true}).check();await dialog.getByRole('button',{name:'Zuordnung speichern'}).click();await expect(dialog).toHaveCount(0)
   await page.getByRole('button',{name:'Artikel Projekten zuordnen'}).click();await dialog.getByLabel('Artikel suchen',{exact:true}).fill(name);await dialog.locator('.catalog-article-picker input').check();await dialog.getByLabel('DEMOSTORAGE · DemoStorage',{exact:true}).check()
   const headers={'access-control-allow-origin':webUrl,'access-control-allow-credentials':'true'}
   await page.route('**/api/inventorySystem/catalog/projects',route=>route.fulfill({status:409,headers,json:{message:'Synthetic conflict'}}),{times:1})
   await page.route('**/api/inventorySystem/state',route=>route.fulfill({status:403,headers,json:{message:'Synthetic access loss'}}),{times:1})
   await dialog.getByRole('button',{name:'Zuordnung speichern'}).click();await expect(page.getByRole('heading',{name:'Zugriff auf Inventar nicht verfügbar',exact:true})).toBeVisible();await expect(dialog).not.toBeVisible()
   await page.getByRole('button',{name:'Erneut versuchen',exact:true}).click();await expect(dialog).toBeVisible();await expect(dialog.locator('.catalog-article-picker input')).toBeChecked();await dialog.getByRole('button',{name:'Schließen',exact:true}).first().click()
   const sw=await pageFor(software);await sw.goto(webUrl+'/projects');const projects=(await call('/state')).data.projects
   for(const project of projects.filter(p=>['DemoStorage','DemoAccess'].includes(p.name))){await sw.getByLabel('Projektübersicht',{exact:true}).first().selectOption(project.id);await expect(sw.locator('.project-parts')).toContainText(name);await expect(sw.locator('.project-parts')).toContainText('Import A '+engineName)}
   await sw.getByRole('button',{name:'Teile anfragen',exact:true}).click();const request=sw.getByRole('dialog')
   await request.getByText('Neues Teil anfragen',{exact:true}).click();await request.getByLabel('Name des neuen Teils',{exact:true}).fill('New sensor '+engineName);await request.getByRole('button',{name:'Zur Anfrage hinzufügen'}).click()
   await request.getByLabel('Lieferantenlink · New sensor '+engineName,{exact:true}).fill('https://example.com/new-sensor')
   await sw.setViewportSize({width:390,height:844});await expect.poll(()=>sw.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
   await sw.screenshot({path:join(output,engineName+'-request-mobile.png'),animations:'disabled'})
   await request.getByRole('button',{name:'Zur Freigabe senden'}).click();await expect(request).toHaveCount(0)
   const sent=(await call('/state')).data.workflows.requests.find(r=>r.itemName==='New sensor '+engineName);assert.equal(sent.supplierUrl,'https://example.com/new-sensor');assert.equal(sent.itemId,undefined)
   for(const theme of ['light','dark']){await page.goto(webUrl+'/catalog');await page.evaluate(theme=>{localStorage.setItem('digital-core-office.theme',theme);dispatchEvent(new StorageEvent('storage',{key:'digital-core-office.theme',newValue:theme}))},theme);await page.getByRole('button',{name:'Artikel Projekten zuordnen'}).click();await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:join(output,engineName+'-projects-'+theme+'.png'),animations:'disabled'});await page.getByRole('dialog').getByRole('button',{name:'Schließen',exact:true}).first().click()}
   assert.deepEqual(errors,[]);results.push({browser:engineName,articlePhoto:true,commaPrice:true,importPreview:true,multiProject:true,newPartRequest:true,history:true,mobileThemes:true})
  }catch(error){for(const [i,p] of browser.contexts().flatMap(c=>c.pages()).entries())await p.screenshot({path:join(output,engineName+'-failure-'+i+'.png'),fullPage:true}).catch(()=>{});throw error}finally{await browser.close()}
 }
 writeFileSync(join(output,'verification.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results))
}finally{await web.close();api.kill();await new Promise(r=>api.exitCode!==null?r():api.once('exit',r));assert.equal(dirname(resolve(directory)),resolve(tmpdir()));rmSync(directory,{recursive:true,force:true})}
