import {createServer} from 'vite'
import {chromium,firefox,expect} from '@playwright/test'
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs'
import path from 'node:path'

const output=path.resolve('../.runtime/company-deploy-20260907/stable-controls-r47')
mkdirSync(output,{recursive:true})
const fixtures=Object.fromEntries(['day-review','approval-queue'].map(name=>{
 const source=readFileSync(new URL(`./${name}.browser.test.mjs`,import.meta.url),'utf8')
 const fixture=source.match(/const fixture=`([\s\S]*?)`\r?\nconst server=/)?.[1]
 if(!fixture)throw Error(`Missing component fixture: ${name}`)
 return [name,fixture]
}))
const server=await createServer({cacheDir:path.join(output,'vite-cache'),plugins:[{
 name:'stable-controls-fixture',
 resolveId(id){if(id.startsWith('virtual:stable-'))return '\0'+id},
 load(id){if(id.startsWith('\0virtual:stable-'))return fixtures[id.slice('\0virtual:stable-'.length)]},
 configureServer(vite){vite.middlewares.use('/stable-controls',async(request,response)=>{
  const name=new URL(request.url,'http://localhost').searchParams.get('view')
  if(!fixtures[name]){response.statusCode=404;response.end();return}
  response.setHeader('Content-Type','text/html')
  response.end(await vite.transformIndexHtml('/stable-controls',`<html><body><div id="root"></div><script type="module" src="/@id/virtual:stable-${name}"></script></body></html>`))
 })}
}],server:{host:'127.0.0.1',port:5196,strictPort:true},logLevel:'error'})

const measure=elements=>elements.map(el=>{
 const rect=el.getBoundingClientRect(),parent=el.parentElement.getBoundingClientRect()
 return {x:rect.x-parent.x,y:rect.y-parent.y,width:rect.width,height:rect.height}
})
const results=[]
await server.listen()
try{for(const [name,type]of [['chromium',chromium],['firefox',firefox]]){
 const browser=await type.launch()
 try{for(const width of [1280,590,390,320])for(const language of ['en','de'])for(const view of Object.keys(fixtures)){
  const page=await browser.newPage({viewport:{width,height:960}}),errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  await page.goto(`http://127.0.0.1:5196/stable-controls?view=${view}`)
  const buttons=page.locator(view==='day-review'?'.day-review-tabs button':'.approval-statuses button')
  await expect(buttons.first()).toBeVisible()
  if(language==='de')await page.getByRole('button',{name:'Language',exact:true}).click()
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,width<600?'dark':'light')
  const baseline=await buttons.evaluateAll(measure),changes=[]
  for(let i=1;i<=baseline.length;i++){
   const index=i%baseline.length
   await buttons.nth(index).click()
   await expect(buttons.nth(index)).toHaveAttribute('aria-pressed','true')
   const after=await buttons.evaluateAll(measure)
   if(JSON.stringify(after)!==JSON.stringify(baseline))changes.push({selected:index,before:baseline,after})
   const style=await buttons.nth(index).evaluate(el=>({border:getComputedStyle(el).borderColor,shadow:getComputedStyle(el).boxShadow}))
   expect(style.shadow).not.toBe('none')
  }
  expect(errors).toEqual([])
  results.push({browser:name,width,language,view,changes})
  if(name==='firefox'&&width===390&&language==='de')await page.screenshot({path:path.join(output,`${view}-mobile.png`),fullPage:true})
  await page.close()
 }}finally{await browser.close()}
}}finally{await server.close()}
const failures=results.filter(result=>result.changes.length)
const recording=process.argv.includes('--record-before')
writeFileSync(path.join(output,recording?'selection-before.json':'selection-verification.json'),JSON.stringify(results,null,2))
console.log(JSON.stringify({cases:results.length,unstableCases:failures.length,example:failures[0]}))
if(!recording)expect(failures,'Selecting a filter must preserve the geometry of every sibling').toEqual([])
