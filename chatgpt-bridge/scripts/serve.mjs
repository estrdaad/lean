import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import worker from '../worker.mjs';
const data = resolve(import.meta.dirname, '../../chatgpt-data');
const ASSETS = {async fetch(request) {
  const path = new URL(request.url).pathname.replace(/^\/data\//, '');
  const file = resolve(data, path);
  if (!file.startsWith(data+'/')) return new Response(null,{status:403});
  try{return new Response(await readFile(file),{headers:{'content-type':'application/json'}});}catch{return new Response(null,{status:404});}
}};
export function serve(port=8787) {
 const server=createServer(async(req,res)=>{
  try {
   const chunks=[]; let size=0;
   for await(const chunk of req){size+=chunk.length;if(size>32768){res.writeHead(413);res.end();return;}chunks.push(chunk);}
   const request=new Request(`http://127.0.0.1:${port}${req.url}`,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
   const response=await worker.fetch(request,{ASSETS});
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500);res.end('Local server error');}
 });
 return server.listen(port,'127.0.0.1');
}
if(process.argv[1]===new URL(import.meta.url).pathname){serve(Number(process.env.PORT)||8787);console.log('MCP local: http://127.0.0.1:8787/mcp');}
