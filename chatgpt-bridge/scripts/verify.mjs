import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import assert from 'node:assert/strict';
const url=process.argv[2];if(!url)throw new Error('Usage: node scripts/verify.mjs https://worker/mcp');
const client=new Client({name:'goog-live-check',version:'1.0'});
try{
 await client.connect(new StreamableHTTPClientTransport(new URL(url)));
 const tools=await client.listTools();assert.equal(tools.tools.length,5);
 const books=await client.callTool({name:'list_books',arguments:{}});assert.equal(books.isError,false);assert.equal(books.structuredContent.books.length,5);
 const result=await client.callTool({name:'search_books',arguments:{bookId:'good-strategy-bad-strategy-ar',query:'التشخيص السياسة الموجهة',limit:3}});assert.equal(result.isError,false);assert.equal(result.structuredContent.results.length,3);
 const p=result.structuredContent.results[0];
 const fetched=await client.callTool({name:'fetch_passage',arguments:{bookId:p.bookId,chapterId:p.chapterId,passageId:p.passageId,version:p.version}});assert.equal(fetched.isError,false);assert.equal(fetched.structuredContent.passage.text,p.text);
 const part=await client.callTool({name:'read_chapter',arguments:{bookId:p.bookId,chapterId:'gs-chapter-5',limit:2}});assert.equal(part.isError,false);assert.equal(part.structuredContent.passages.length,2);
 console.log(JSON.stringify({url,tools:tools.tools.length,books:books.structuredContent.books.length,searchResults:result.structuredContent.results.length,fetchMatches:true,pagination:part.structuredContent.nextStart,passed:true},null,2));
}finally{await client.close();}
