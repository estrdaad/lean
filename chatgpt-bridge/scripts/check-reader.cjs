const {chromium}=require('/Users/mswd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');const catalog=JSON.parse(fs.readFileSync(path.join(root,'chatgpt-data/catalog.json')));const out=path.join(root,'output/chatgpt-bridge');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});const results=[];
 try{
  for(const mobile of [false,true]){
   const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:850},isMobile:mobile,hasTouch:mobile});
   await context.route('**/firebase-config.js',r=>r.fulfill({contentType:'text/javascript',body:'window.READER_FIREBASE_CONFIG=null;'}));
   await context.route('https://**/*',r=>r.abort());
   const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   const targets=mobile?catalog.books.filter(b=>b.id==='good-strategy-bad-strategy-ar'):catalog.books;
   for(const book of targets){
    const chapter=book.chapters[Math.floor(book.chapters.length/3)];
    const data=JSON.parse(fs.readFileSync(path.join(root,`chatgpt-data/books/${book.id}/${book.version}/chapters/${chapter.id}.json`)));
    const target=data.passages[Math.min(3,data.passages.length-1)];
    const url=new URL('http://127.0.0.1:8093/');for(const[k,v]of Object.entries({book:book.id,chapter:chapter.id,block:target.block,offset:target.offset}))url.searchParams.set(k,v);
    await page.goto(url.href,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.LibbyApp?.state.readingLocation&&document.getElementById('view-reader').classList.contains('active'));
    await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(150);
    const sampled=data.passages.filter((_,i)=>i%Math.max(1,Math.floor(data.passages.length/20))===0);
    const actual=await page.evaluate(passages=>{
     const blocks=[...document.querySelectorAll('#book-article p,#book-article h1,#book-article h2,#book-article h3,#book-article h4,#book-article li,#book-article figure,#book-article table')];
     return {id:window.BookLibrary.activeBook.id,location:window.LibbyApp.state.readingLocation,matches:passages.map(p=>({id:p.id,match:blocks[p.block]?.textContent.slice(p.offset,p.offset+p.text.length)===p.text}))};
    },sampled);
    assert.equal(actual.id,book.id);assert.ok(actual.location.block>=0);assert.ok(actual.matches.every(x=>x.match),JSON.stringify({book:book.id,bad:actual.matches.filter(x=>!x.match)}));
    results.push({device:mobile?'mobile':'desktop',book:book.id,exactPassageMatches:actual.matches.length});
   }
   await page.getByRole('button',{name:'أدوات القراءة',exact:true}).click();await page.getByRole('button',{name:'ناقش في ChatGPT',exact:true}).click();
   assert.ok(await page.locator('#chatgpt-dialog').isVisible());assert.ok((await page.locator('#chatgpt-context').inputValue()).includes('معرّف الكتاب:'));
   await page.screenshot({path:path.join(out,`discussion-${mobile?'mobile':'desktop'}.png`)});
   await page.getByRole('button',{name:'إغلاق المناقشة',exact:true}).click();
   await page.evaluate(()=>window.BookLibrary.open());
   await Promise.all([page.waitForEvent('load'),page.getByRole('button',{name:'الشركة الناشئة المرنة',exact:true}).click()]);await page.evaluate(()=>window.BookLibrary.ready);
   assert.equal(await page.evaluate(()=>window.BookLibrary.activeBook.id),'lean-startup');
   assert.equal(new URL(page.url()).searchParams.has('book'),false);
   await page.goto('http://127.0.0.1:8093/chatgpt-setup.html');await page.waitForFunction(()=>!document.getElementById('copy-url').disabled);
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);assert.deepEqual(errors,[]);
   await context.close();
  }
  fs.writeFileSync(path.join(out,'reader-validation.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
