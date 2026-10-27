"""Build bounded, public reading/search assets from catalogued reader-book JSON only."""
import hashlib, json, math, re, shutil, unicodedata
from collections import Counter, defaultdict
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'chatgpt-data'
TAGS = set('p h1 h2 h3 h4 li figure table'.split())
STOP = set('في من على الى عن ان او هذا هذه ذلك التي الذي مع ما لا لم لن هو هي كان كانت كل قد لقد ثم بين عند حيث حتى كما بعد قبل خلال اذا و يا هل اي أي إلى أن إن أو'.split())

def normalize(s):
    s = ''.join(c for c in unicodedata.normalize('NFKD', s.lower()) if not unicodedata.category(c).startswith('M'))
    return s.translate(str.maketrans({'أ':'ا','إ':'ا','آ':'ا','ٱ':'ا','ى':'ي','ة':'ه','ـ':''}))
STOP = {normalize(t) for t in STOP}
def tokens(s):
    words = re.findall(r'[^\W_]+', normalize(s), re.UNICODE)
    return [w[2:] if w.startswith('ال') and len(w)>4 else w for w in words if len(w)>1 and w not in STOP]

def bucket(term):
    # Stable across Python and JS, with no crypto dependency in the request handler.
    value = 2166136261
    for b in term.encode(): value = ((value ^ b) * 16777619) & 0xffffffff
    return f'{value & 255:02x}'

def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':'))+'\n')

class ReaderHTML(HTMLParser):
    def __init__(self, toc):
        super().__init__(convert_charrefs=True)
        self.stack=[]; self.blocks=[]; self.chapter=None; self.toc={x['id']:x['title'] for x in toc}; self.source_page=None; self.skip=0
    def handle_starttag(self, tag, attrs):
        attrs=dict(attrs)
        if tag in ('script','style'): self.skip+=1
        ident=attrs.get('id','')
        if ident in self.toc: self.chapter=ident
        match=re.search(r'(?:pdf-page-|pdf-p|page-)(\d+)$',ident)
        if match: self.source_page=int(match[1])
        if tag in TAGS:
            block={'block':len(self.blocks),'chapterId':self.chapter,'sourcePage':self.source_page,'parts':[],'children':False}
            if self.stack: self.stack[-1][1]['children']=True
            self.blocks.append(block); self.stack.append((tag,block))
        if tag=='br': self.handle_data('\n')
    def handle_endtag(self,tag):
        if tag in ('script','style'): self.skip=max(0,self.skip-1)
        if tag in TAGS:
            for i in range(len(self.stack)-1,-1,-1):
                if self.stack[i][0]==tag: del self.stack[i:]; break
    def handle_data(self,data):
        if not self.skip:
            for _,block in self.stack: block['parts'].append(data)


def main():
    if OUT.exists(): shutil.rmtree(OUT)
    catalog=json.loads((ROOT/'books/catalog.json').read_text()); books=[]; report=[]
    for entry in catalog:
        path=(ROOT/entry['path']).resolve()
        if path.parent != (ROOT/'books').resolve(): raise ValueError('Book outside books directory')
        book=json.loads(path.read_text()); ident=book['id']
        assert re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}',ident) and ident==entry['id']
        assert book['format']=='reader-book' and book['version']==1
        version=hashlib.sha256(book['contentHtml'].encode()).hexdigest()[:16]
        parser=ReaderHTML(book['toc']); parser.feed(book['contentHtml'])
        chapters={item['id']:{**item,'passages':[]} for item in book['toc']}
        postings=defaultdict(list); total=0
        for block in parser.blocks:
            if block['children'] or block['chapterId'] not in chapters: continue
            text=''.join(block['parts'])
            if not text.strip(): continue
            # Keep UTF-16 offsets to match browser Range offsets, even for astral Unicode.
            start=0
            while start<len(text):
                end=min(len(text),start+1600)
                if end<len(text):
                    cut=text.rfind(' ',start+800,end)
                    if cut>start: end=cut
                chunk=text[start:end].strip()
                leading=len(text[start:end])-len(text[start:end].lstrip())
                offset=len(text[:start+leading].encode('utf-16-le'))//2
                chapter=chapters[block['chapterId']]
                passage_id=f"b{block['block']}-o{offset}"
                passage={'id':passage_id,'text':chunk,'block':block['block'],'offset':offset,'sourcePage':block['sourcePage']}
                chapter['passages'].append(passage); total+=1
                # Exclude endnotes and bibliographies from ordinary search, but keep readable.
                if not re.search(r'notes|references|sources|index',chapter['id'],re.I):
                    counts=Counter(tokens(chunk)); length=max(1,sum(counts.values()))
                    for token,frequency in counts.items():
                        postings[token].append([chapter['id'],passage_id,round(frequency/(frequency+0.5+length/180),4)])
                start=end
        shards=defaultdict(dict)
        for token,items in postings.items():
            rarity=math.log(1+total/len(items))
            items.sort(key=lambda x:-x[2])
            shards[bucket(token)][token]=[[c,p,round(score*rarity,4)] for c,p,score in items[:128]]
        folder=OUT/'books'/ident/version
        metas=[]
        for chapter in chapters.values():
            if not re.fullmatch(r'[A-Za-z0-9_.:-]+',chapter['id']): raise ValueError('Unsafe chapter ID')
            write(folder/'chapters'/f"{chapter['id']}.json",chapter)
            metas.append({'id':chapter['id'],'title':chapter['title'],'passages':len(chapter['passages'])})
        for i in range(256): write(folder/'search'/f'{i:02x}.json',shards.get(f'{i:02x}',{}))
        metadata={k:book.get(k,'') for k in ('id','title','author','description','language','direction','sourcePages')}
        metadata.update(version=version,chapters=metas,totalPassages=total)
        write(folder/'book.json',metadata); books.append(metadata)
        report.append({'id':ident,'chapters':len(metas),'passages':total,'version':version})
    write(OUT/'catalog.json',{'format':'reader-mcp-library','version':1,'books':books})
    print(json.dumps({'books':report,'files':sum(1 for p in OUT.rglob('*') if p.is_file()),'bytes':sum(p.stat().st_size for p in OUT.rglob('*') if p.is_file())},ensure_ascii=False,indent=2))

if __name__=='__main__': main()
