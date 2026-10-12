"""Refresh the direct-file fallback after editing the bundled book JSON."""
import json
from pathlib import Path
root = Path(__file__).resolve().parent.parent
book = json.loads((root / 'books/lean-startup.json').read_text(encoding='utf-8'))
(root / 'books/bundled-book.js').write_text(
    '// Offline fallback for opening index.html directly. Generated from lean-startup.json.\n'
    'window.BUNDLED_READER_BOOK = ' + json.dumps(book, ensure_ascii=False, indent=2) + ';\n',
    encoding='utf-8',
)
