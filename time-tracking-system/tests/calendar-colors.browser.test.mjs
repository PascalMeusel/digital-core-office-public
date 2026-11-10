// Run from the repository root, after building all four clients.
import {createServer} from 'node:http'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {chromium,firefox,expect} from '@playwright/test'
const output='.runtime/company-deploy-20260907/calendar-color-r51'
mkdirSync(output,{recursive:true})
const modules={core:['core-service','core-shell'],time:['time-tracking-system','app-shell'],inventory:['inventory-management-system','inventory-system'],agile:['agile-project-management-prototype','app-shell']}
const kinds=['holiday','vacation','sick_leave','child_sick_leave','overtime_time_off','external_busy','custom_event']
const server=createServer((request,response)=>{
 const query=new URL(request.url,'http://127.0.0.1'),key=query.searchParams.get('module')
 if(!modules[key]){response.writeHead(404);response.end();return}
 const [folder,root]=modules[key]
 const index=readFileSync(folder+'/dist/index.html','utf8'),asset=index.match(/href="([^"]*\/assets\/[^"?]+\.css)"/)[1].split('/').at(-1)
 const css=readFileSync(folder+'/dist/assets/'+asset,'utf8')
 const days=['','weekend','today'].map(cls=>`<div class="calendar-day ${cls}"><span class="calendar-day-number">9</span><div class="calendar-day-items">${kinds.map(kind=>`<button class="calendar-compact-item calendar-event-button ${kind==='holiday'?'holiday-pill':`absence-pill ${kind}`}">${kind}</button>`).join('')}</div></div>`).join('')
 response.setHeader('Content-Type','text/html');response.end(`<html data-theme="${query.searchParams.get('theme')}"><head><style>${css}</style></head><body><main class="${root}" style="padding:20px"><h1>Workspace</h1>${key==='time'?`<section class="calendar-panel" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr))">${days}</section>`:''}</main></body></html>`)
})
function luminance(value){const c=value.match(/[\d.]+/g).slice(0,3).map(v=>Number(v)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return c.reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0)}
function contrast(a,b){const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05)}
await new Promise(resolve=>server.listen(5198,'127.0.0.1',resolve))
const results=[]
try{for(const [name,type]of [['chromium',chromium],['firefox',firefox]]){
 const browser=await type.launch()
 try{for(const theme of ['light','dark']){
  const styles=[]
  for(const [module,[,root]]of Object.entries(modules)){
   const page=await browser.newPage({viewport:{width:1100,height:780},reducedMotion:'reduce'})
   await page.goto(`http://127.0.0.1:5198/?module=${module}&theme=${theme}`)
   const style=await page.locator('.'+root).evaluate(el=>{const s=getComputedStyle(el);return{image:s.backgroundImage,base:s.backgroundColor,fade:s.getPropertyValue('--dco-workspace-fade').trim(),opacity:s.getPropertyValue('--dco-workspace-opacity').trim(),tint:s.getPropertyValue('--dco-workspace-tint').trim()}})
   expect(style.image).toContain('linear-gradient(');expect(style.image).toContain(theme==='dark'?'280px':'260px')
   styles.push(style)
   if(module==='time'){
    const today=await page.locator('.today .calendar-day-number').evaluate(el=>({fg:getComputedStyle(el).color,bg:getComputedStyle(el).backgroundColor}))
    expect(contrast(today.fg,today.bg)).toBeGreaterThanOrEqual(4.5)
    const samples=await page.locator('.calendar-compact-item').evaluateAll(els=>els.map(el=>{const s=getComputedStyle(el);return{bg:s.backgroundColor,fg:s.color,height:el.getBoundingClientRect().height}}))
    expect(new Set(samples.slice(0,7).map(s=>s.bg)).size).toBe(7)
    for(let i=0;i<samples.length;i++){
     expect(samples[i].bg).not.toContain('rgba(')
     expect(contrast(samples[i].fg,samples[i].bg)).toBeGreaterThanOrEqual(5)
     expect(samples[i]).toEqual(samples[i%7])
     expect(samples[i].height).toBe(20)
    }
    const control=page.locator('.calendar-compact-item').first(),before=await control.boundingBox()
    await control.hover();expect(await control.boundingBox()).toEqual(before)
    expect(await control.evaluate(el=>getComputedStyle(el).filter)).toBe('none')
    await control.focus();expect(await control.evaluate(el=>getComputedStyle(el).outlineStyle)).toBe('solid')
    await page.screenshot({path:`${output}/palette-${name}-${theme}.png`})
   }
   results.push({browser:name,module,theme,...style});await page.close()
  }
  expect(new Set(styles.map(s=>s.image.replace(/rgba?\([^)]+\)/g,'COLOR'))).size).toBe(1)
  expect(new Set(styles.map(s=>s.base)).size).toBe(1)
  expect(new Set(styles.map(s=>s.tint)).size).toBe(4)
 }}finally{await browser.close()}
}}finally{await new Promise(resolve=>server.close(resolve))}
writeFileSync(output+'/color-verification.json',JSON.stringify(results,null,2))
console.log(JSON.stringify({ok:true,backgroundCases:results.length,calendarCategories:7,minimumContrast:5,opaqueAcrossDayBackgrounds:true,stableHoverAndVisibleFocus:true}))
