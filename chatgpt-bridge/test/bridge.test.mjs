import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {serve} from '../scripts/serve.mjs';
import worker, {normalize, terms, bucket} from '../worker.mjs';
let server,client;
before(async()=>{server=serve(18787);await new Promise(r=>server.on('listening',r));client=new Client({name:'reader-integration-test',version:'1.0'});await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:18787/mcp')));});
after(async()=>{await client?.close();await new Promise(r=>server.close(r));});
const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});assert.equal(r.isError,false,JSON.stringify(r));return r.structuredContent;};
test('official MCP client initializes, discovers read-only tools, and lists five books',async()=>{
 const tools=await client.listTools();assert.equal(tools.tools.length,5);assert.ok(tools.tools.every(t=>t.annotations.readOnlyHint));
 const data=await call('list_books');assert.equal(data.books.length,5);assert.ok(data.books.every(b=>b.version&&b.chapters>0));
});
test('Arabic normalization and index buckets match compiled source',async()=>{
 assert.equal(normalize('إِسْتِراتِيجيَّة'),normalize('استراتيجية'));assert.deepEqual(terms('في النواة'),['نواه']);
 const {books}=await call('list_books');const b=books.find(b=>b.id==='good-strategy-bad-strategy-ar');
 const shard=JSON.parse(await readFile(new URL(`../../chatgpt-data/books/${b.id}/${b.version}/search/${bucket('نواه')}.json`,import.meta.url),'utf8'));
 assert.ok(shard['نواه'].length);
});
test('search, exact fetch, citations, pagination and version checks',async()=>{
 const bookId='good-strategy-bad-strategy-ar';
 const found=await call('search_books',{bookId,query:'التشخيص السياسة الموجهة',limit:4});assert.equal(found.results.length,4);
 const p=found.results[0];const fetched=await call('fetch_passage',{bookId,chapterId:p.chapterId,passageId:p.passageId,version:p.version});assert.equal(fetched.passage.text,p.text);assert.ok(p.url.includes('block='));
 const part=await call('read_chapter',{bookId,chapterId:'gs-chapter-5',limit:2});assert.equal(part.passages.length,2);assert.equal(part.nextStart,2);
 const next=await call('read_chapter',{bookId,chapterId:'gs-chapter-5',start:part.nextStart,limit:2});assert.notEqual(part.passages[0].passageId,next.passages[0].passageId);
 const stale=await client.callTool({name:'fetch_passage',arguments:{bookId,chapterId:p.chapterId,passageId:p.passageId,version:'0000000000000000'}});assert.equal(stale.isError,true);
});
test('cross-library search stays bounded and cannot read arbitrary paths',async()=>{
 const result=await call('search_books',{query:'القيادة',limit:4});assert.ok(result.results.length<=4);assert.equal(result.scope.length,5);
 for(const args of [{bookId:'../../etc/passwd'},{bookId:'good-strategy-bad-strategy-ar',url:'https://evil.example'}]){
  const result=await client.callTool({name:'get_book',arguments:args});assert.equal(result.isError,true);
 }
 const overflow=await client.callTool({name:'read_chapter',arguments:{bookId:'lean-startup',chapterId:'x',limit:999999}});assert.equal(overflow.isError,true);
});
test('malformed transport, untrusted Origin, size and method restrictions',async()=>{
 const req=(body,headers={})=>new Request('https://example.test/mcp',{method:'POST',headers:{'content-type':'application/json',...headers},body});
 assert.equal((await worker.fetch(req('{'))).status,400);
 assert.equal((await worker.fetch(req(JSON.stringify([])))).status,400);
 assert.equal((await worker.fetch(req('{}',{'origin':'https://evil.example'}))).status,403);
 assert.equal((await worker.fetch(req('x'.repeat(33000)))).status,413);
 assert.equal((await worker.fetch(new Request('https://example.test/mcp'))).status,405);
 assert.equal((await worker.fetch(req(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})))).status,202);
});
