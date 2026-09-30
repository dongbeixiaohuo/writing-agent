"""Built real renderer regression, deterministic parse counts, no external I/O."""
import json, subprocess, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
label=sys.argv[1]
folder=Path('output/rc42/markdown')/label; folder.mkdir(parents=True,exist_ok=True)
subprocess.run(['node','-e',"require('esbuild').buildSync({entryPoints:['tests/ux/markdown_render_regression.tsx'],bundle:true,outfile:process.argv[1],format:'iife',define:{'process.env.NODE_ENV':'\"production\"'},jsx:'automatic'})",str(folder/'fixture.js')],check=True)
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True); page=browser.new_page()
    page.set_content('<div id="root"></div>'); page.add_script_tag(path=str(folder/'fixture.js'))
    result=page.evaluate('window.result'); browser.close()
(folder/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8'); print(json.dumps(result))
assert result['initial']==80 and result['liveParses']==31
assert result['repeatedHistoryParses']==0,'Unchanged history reparsed while the stream updates'
