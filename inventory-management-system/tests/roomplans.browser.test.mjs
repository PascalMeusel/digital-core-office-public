import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium, firefox, expect } from '../../time-tracking-system/node_modules/@playwright/test/index.mjs'

process.chdir(fileURLToPath(new URL('../', import.meta.url)))
const directory=mkdtempSync(join(tmpdir(),'dco-roomplans-')), output=resolve(process.env.INVENTORY_ROOM_PLAN_TEST_MEDIA?'../artifacts/inventory-roomplans':'../artifacts/inventory-roomplans-ci')
const media=join(directory,'static-media'), suppliedMedia=process.env.INVENTORY_ROOM_PLAN_TEST_MEDIA
mkdirSync(join(media,'plans'),{recursive:true});mkdirSync(join(media,'photos'));mkdirSync(output,{recursive:true})
const drawing='<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="white"/><path d="M10 10H790V590H10Z M400 10V590" fill="none" stroke="black" stroke-width="4"/></svg>'
const reference=JSON.parse(readFileSync('server/reference/inventorySource.json','utf8'))
const rooms=reference.rooms.map(room=>{
 const extension=suppliedMedia?'png':'svg', file=`regression-room-${room.code}.${extension}`
 if(suppliedMedia)copyFileSync(join(suppliedMedia,'plans',`room-${room.code}.png`),join(media,'plans',file));else writeFileSync(join(media,'plans',file),drawing)
 assert(!existsSync(join('dist','inventory-media','plans',file)),'The test must use persisted media, not bundled files or a dist symlink')
 return {...room,planImagePath:'/inventory-media/plans/'+file}
})
writeFileSync(join(media,'photos','test-shelf.svg'),drawing)
writeFileSync(join(directory,'reference.json'),JSON.stringify({rooms,locations:[],rows:[]}))
const webUrl='http://127.0.0.1:5215',apiUrl='http://127.0.0.1:5297',password='L7!nRf4*Kw9#pUv8'
const api=spawn(process.execPath,['--import','tsx','server/index.ts'],{windowsHide:true,env:{...process.env,PORT:'5297',HOST:'127.0.0.1',CORS_ORIGIN:webUrl,DCO_CORE_URL:'',DISABLE_LOCAL_WEB_LOGIN:'false',INVENTORY_SYSTEM_DATA:join(directory,'inventory.sqlite'),INVENTORY_STATIC_MEDIA_DIR:'',INVENTORY_MEDIA_DIR:join(directory,'media'),INVENTORY_REFERENCE_DATA_FILE:join(directory,'reference.json'),INVENTORY_SYSTEM_ADMIN_NAME:'Room plan tester',INVENTORY_SYSTEM_ADMIN_EMAIL:'roomplan@example.test',INVENTORY_SYSTEM_ADMIN_PASSWORD:password}})
let log='';api.stdout.on('data',v=>log+=v);api.stderr.on('data',v=>log+=v)
const web=await createServer({base:'/inventory/',server:{host:'127.0.0.1',port:5215,strictPort:true,proxy:{'/inventory/api':{target:apiUrl,rewrite:path=>path.slice('/inventory'.length)},'/inventory/inventory-media':{target:apiUrl,rewrite:path=>path.slice('/inventory'.length)}}},define:{'import.meta.env.VITE_API_URL':JSON.stringify('/inventory')}})
try{
 await web.listen();for(let n=0;n<60;n++){try{await fetch(apiUrl+'/api/health');break}catch{if(n===59)throw Error(log);await new Promise(r=>setTimeout(r,150))}}
 for(const room of rooms){const response=await fetch(apiUrl+room.planImagePath);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^image\//);assert.deepEqual(Buffer.from(await response.arrayBuffer()),readFileSync(join(media,room.planImagePath.slice('/inventory-media/'.length))))}
 for(const path of ['/inventory-media/plans/missing.png','/inventory-media/plans/','/inventory-media/%2e%2e%2finventory.sqlite']){const response=await fetch(apiUrl+path);assert.equal(response.status,404);assert.match(response.headers.get('content-type'),/json/)}
 const login=await fetch(apiUrl+'/api/inventorySystem/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'roomplan@example.test',password})})
 assert(login.ok);const state=await login.json(),cookie=login.headers.getSetCookie().find(v=>v.startsWith('inventory_session=')).split(';')[0]
 const headers={Cookie:cookie,'x-inventory-csrf':state.csrfToken,'Content-Type':'application/json'}
 const roomLocations=state.locations.filter(location=>location.kind==='room')
 assert.equal(roomLocations.length,3,'Every room plan must have a room, including rooms without stock')
 for(const room of rooms){const place=roomLocations.find(location=>location.roomCode===room.code);assert(place);assert.equal(place.planImagePath,room.planImagePath)}
 const parentId=roomLocations.find(l=>l.roomCode==='001').id
 const location=await fetch(apiUrl+'/api/inventorySystem/locations',{method:'POST',headers,body:JSON.stringify({name:'Soldering table',code:'001-ST101',fixtureCode:'ST101',kind:'fixture',parentId,roomCode:'001',roomName:'Soldering Room',planImagePath:rooms[0].planImagePath,photoPath:'/inventory-media/photos/test-shelf.svg'})})
 assert(location.ok,JSON.stringify(await location.json()))
 const results=[]
 for(const [name,engine] of [['chromium',chromium],['firefox',firefox]]){
  const browser=await engine.launch({headless:true})
  try{
   const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addCookies([{name:'inventory_session',value:cookie.split('=')[1],url:webUrl}]);await context.addInitScript(()=>localStorage.setItem('digital-core-office.language','de'))
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message))
   await page.goto(webUrl+'/inventory/locations')
   for(const room of rooms)await expect(page.locator('.location-tree-main strong').filter({hasText:room.name})).toHaveCount(1)
   await expect(page.locator('.location-directory-metrics article').first().locator('strong')).toHaveText('3')
   await page.locator('.location-plan-disclosure > summary').click()
   for(const width of [390,1440])for(const theme of ['light','dark']){
    await page.setViewportSize({width,height:1000});await page.evaluate(theme=>{localStorage.setItem('digital-core-office.theme',theme);dispatchEvent(new StorageEvent('storage',{key:'digital-core-office.theme',newValue:theme}))},theme)
    for(const room of rooms)await expect(page.locator('.location-tree-main strong').filter({hasText:room.name})).toBeVisible()
    for(const room of rooms){
     await page.locator('.location-visual-toolbar select').selectOption(room.code)
     const plan=page.locator('.interactive-floorplan'),image=plan.locator('img')
     await expect(image).toHaveAttribute('src','/inventory'+room.planImagePath)
     await expect.poll(()=>image.evaluate(img=>img.complete&&img.naturalWidth>0)).toBe(true)
     await expect.poll(()=>plan.evaluate(stage=>{const img=stage.querySelector('img'),r=img.getBoundingClientRect();return Math.abs(r.width/r.height-img.naturalWidth/img.naturalHeight)<0.01&&r.height>80&&stage.clientHeight>=r.height-1})).toBe(true)
     await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
     if(room.code==='001'){
      const hotspot=plan.getByRole('button',{name:'ST101, 0 Bestandspositionen',exact:true});await hotspot.click();await expect(hotspot).toHaveAttribute('aria-pressed','true')
      await expect.poll(()=>page.locator('.location-photo-grid img').evaluate(img=>img.complete&&img.naturalWidth>0)).toBe(true)
      const before=await image.boundingBox();await page.getByTitle('Vergrößern',{exact:true}).click();await expect.poll(async()=>Math.round((await image.boundingBox()).width/before.width*100)).toBe(125)
      await expect.poll(()=>hotspot.evaluate(el=>Math.abs(el.offsetTop/el.parentElement.clientHeight-.135)<.005)).toBe(true)
      await page.getByTitle('Verkleinern',{exact:true}).click();await expect.poll(async()=>Math.round((await image.boundingBox()).width/before.width*100)).toBe(100)
     }
     await page.mouse.move(0,0);if(name==='chromium')await page.locator('.location-visual-browser').screenshot({path:join(output,`room-${room.code}-${width}-${theme}.png`),animations:'disabled'})
    }
   }
   assert.deepEqual(errors,[]);results.push({browser:name,rooms:3,emptyRoomsInStructure:true,persistedImagesWithoutBuildSymlink:true,productionUrlPrefix:true,missingImage404:true,originalAspectRatio:true,zoomAndMarkerAlignment:true,photos:true,responsiveAndThemes:true,companyPlans:Boolean(suppliedMedia)})
  }finally{await browser.close()}
 }
 writeFileSync(join(output,'verification.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results))
}finally{await web.close();api.kill();await new Promise(r=>api.exitCode!==null?r():api.once('exit',r));assert.equal(dirname(resolve(directory)),resolve(tmpdir()));rmSync(directory,{recursive:true,force:true})}
