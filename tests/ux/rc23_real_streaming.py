"""Explicitly authorized MiniMax desktop UAT. Fresh workspace; no user project access."""
import argparse
import json
import os
import shutil
import socket
import subprocess
import time
import uuid
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('executable')
parser.add_argument('--allow-real-model', action='store_true', required=True)
parser.add_argument('--rounds', type=int, default=3, choices=[1, 2, 3])
parser.add_argument('--observe-only', action='store_true')
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
test_id = 'rc23-' + uuid.uuid4().hex
test_root = Path(os.environ['TEMP']) / ('writing-agent-desktop-test-' + test_id)
(test_root / 'user-data').mkdir(parents=True)
(test_root / 'workspace').mkdir()
profile = Path(os.environ['APPDATA']) / 'Writing Agent/provider.json'
config = json.loads(profile.read_text(encoding='utf-8-sig'))
assert config['model'] == 'MiniMax-M3'
assert 'apiKey' not in config  # Reuse credential reference, never extract/print the key.
shutil.copyfile(profile, test_root / 'user-data/provider.json')
evidence = root / 'output/rc23-real-streaming' / test_id
evidence.mkdir(parents=True)
report = dict(status='FAIL', executable=args.executable, isolatedRoot=str(test_root), originalProjectWrites=0, rounds=[])
messages = [
    '不知道写什么，给我三个日常观察的小方向，每个用两三句话解释。先聊，不要生成正文或替我确认方向。',
    '想写成年人周末无所事事却又有点内疚的感觉。请给三个不同的切入角度，每个约150字，比较各自优缺点。只讨论，暂时不要形成方案或写正文。',
    '想写一篇1000字的轻散文，给普通成年人看，讨论想象中本可能成为的自己与当下的落差。请建议方向，用第二人称，结尾轻微和解，不编造亲历。请先提方案让我确认，不要开始正文。',
]
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
with (evidence / 'electron-stderr.log').open('wb') as stderr:
    process = subprocess.Popen([args.executable, f'--remote-debugging-port={port}', '--remote-debugging-address=127.0.0.1', '--disable-gpu'],
        env=dict(os.environ, WRITING_AGENT_DESKTOP_TEST=test_id), stdout=subprocess.DEVNULL, stderr=stderr, creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        deadline = time.monotonic() + 25
        while True:
            try:
                with urlopen(f'http://127.0.0.1:{port}/json/version', timeout=1) as response: endpoint = json.load(response)['webSocketDebuggerUrl']
                break
            except Exception:
                if time.monotonic() >= deadline: raise
                time.sleep(.2)
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(endpoint)
            page = browser.contexts[0].pages[0]; page.wait_for_load_state('networkidle')
            page.set_viewport_size(dict(width=1344, height=866))

            def rpc(method, values=None):
                result = page.evaluate('(x)=>window.writingAgentDesktop.invoke({protocolVersion:20,method:x.method,args:x.args})', dict(method=method, args=values or []))
                assert result['ok'], result
                return result['result']

            assert rpc('getSnapshot')['projects'] == []
            for index, message in enumerate(messages[:args.rounds]):
                if index: page.get_by_role('button', name='新建项目', exact=True).click()
                page.evaluate('''()=>{
                  window.stopStreamProbe?.(); window.streamProbeObserver?.disconnect();
                  window.streamProbe={start:performance.now(), snapshots:[],dom:[],waitingSeen:false,last:null};
                  const x=window.streamProbe;
                  window.stopStreamProbe=window.writingAgentDesktop.subscribe(s=>{
                    x.last=s; const live=s.liveReply;
                    if(live) {const requests=s.runRecords.find(r=>r.id===live.runId)?.diagnostics?.segments.flatMap(g=>g.modelRequests)||[];
                      x.snapshots.push({t:performance.now()-x.start,len:live.text.length,pendingRequest:requests.at(-1)?.status==='pending'});}
                  });
                  window.streamProbeObserver=new MutationObserver(()=>{
                    if(document.querySelector('[aria-label="正在处理你的消息"]'))x.waitingSeen=true;
                    const el=document.querySelector('[aria-label="正在生成的回复"]');
                    if(el) {const text=el.firstElementChild?.textContent||'';
                      if(x.dom.at(-1)?.len!==text.length)x.dom.push({t:performance.now()-x.start,len:text.length,active:!!x.last?.activeRunId});}
                  }); window.streamProbeObserver.observe(document.body,{subtree:true,childList:true,characterData:true});
                }''')
                editor = page.get_by_role('textbox', name='写作指令', exact=True)
                editor.fill(message)
                page.evaluate('()=>{window.streamProbe.start=performance.now()}')
                editor.press('Enter')
                began = time.monotonic(); deadline = began + 150; seen = False; photographed = False
                while time.monotonic() < deadline:
                    snapshot = rpc('getSnapshot')
                    if snapshot['runRecords']: seen = True
                    if snapshot.get('liveReply') and not photographed:
                        page.screenshot(path=str(evidence / f'round-{index+1}-partial.png')); photographed = True
                    if seen and snapshot['activeRunId'] is None: break
                    page.wait_for_timeout(100)
                else:
                    if snapshot['activeRunId']: rpc('cancelRun', [snapshot['activeRunId']])
                    raise AssertionError('isolated turn timed out')
                sample = page.evaluate('()=>{const x=window.streamProbe;window.stopStreamProbe();window.streamProbeObserver.disconnect();return {snapshots:x.snapshots,dom:x.dom,waitingSeen:x.waitingSeen}}')
                run = snapshot['runRecords'][-1]
                lengths = {s['len'] for s in sample['snapshots'] if s['pendingRequest']}
                progressive = len(lengths) >= 3 and len(sample['dom']) >= 3
                row = dict(round=index+1, runId=run['id'], status=run['status'], stopReason=run['stopReason'], elapsedMs=round((time.monotonic()-began)*1000),
                    firstVisibleMs=sample['dom'][0]['t'] if sample['dom'] else None, progressive=progressive, modelRequests=run['modelRequests'], tokens=run.get('totalTokens'), **sample)
                report['rounds'].append(row)
                (evidence / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
                print(json.dumps({k:v for k,v in row.items() if k not in ['dom','snapshots']}, ensure_ascii=False), flush=True)
                page.screenshot(path=str(evidence / f'round-{index+1}-saved.png'))
                assert run['status'] == 'completed', run['stopReason']
                if not args.observe_only:
                    assert progressive, 'No demonstrated progressive UI text while a model request was pending'
                    assert sample['waitingSeen'], 'Missing pre-text feedback'
            report['status'] = 'OBSERVED' if args.observe_only else 'PASS'
            browser.close()
    finally:
        process.terminate(); process.wait(timeout=15)
        (evidence / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(dict(status=report['status'], evidence=str(evidence)), ensure_ascii=False))
