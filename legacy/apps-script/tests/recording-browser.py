#!/usr/bin/env python3
"""Offline browser checks for packing recordings (Chromium + Playwright).

Run: python tests/recording-browser.py
Pass --fragment FILE while developing the SCAN through UPLOAD QUEUE section.
The harness uses real browser IndexedDB and deterministic synthetic recorder/RPC
implementations. No Google services, accounts, or real camera are contacted.
"""

import argparse
import contextlib
import http.server
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]

HARNESS = r"""<!doctype html><meta charset="utf-8"><title>Recording tests</title>
<div id="camFrame"></div><div id="state"></div><div id="stateLabel"></div>
<div id="curResi"></div><div id="timer"></div><div id="dupWarn" hidden></div>
<div id="orderBox"><div id="itemCount"></div><div id="orderWho"></div><ul id="orderItems"></ul></div>
<button id="btnStop"></button><ul id="queue"></ul><input id="scan">
<input id="stationName" value="Test bench"><div id="modal" hidden></div>
<div id="connGate" hidden></div><div id="loginGate" hidden></div>
<div id="recordingNotice"></div><div id="storageWarning"></div>
<canvas id="cv" width="320" height="180"></canvas>
<script>
const $ = id => document.getElementById(id);
const fakeTrack = Object.assign(new EventTarget(),{readyState:'live',enabled:true,muted:false});
const camVideo={readyState:4,videoWidth:320};
const ST = {mode:'station', packer:{id:'packer-test',name:'Test packer',code:'PK0001'},
  stream:{getTracks:()=>[],getVideoTracks:()=>[fakeTrack]},recorder:null,chunks:[],current:null,
  stopping:null,queue:[],tickTimer:null};
const CFG={packers:[ST.packer],maxSec:180,bitrate:700000};
const ROLE={value:'user'};
const STOP_CODES=['STOP','SELESAI','#STOP'];
const cv=$('cv'); cv.captureStream=()=>({getTracks:()=>[]});
const BACKEND={url:'http://unused.invalid',key:'test'};
const HOSTED=false;
const S={get:(k,d)=>d,set:()=>{},del:()=>{}};
const messages=[];
function toast(message,error){messages.push({message,error});}
function beep(){}
function setPacker(p){ST.packer=p;}
function cleanCode(value){return String(value||'').replace(/\s+/g,'').toUpperCase();}
function errMsg(error){return String(error&&error.message||error);}
function pad(value){return String(value).padStart(2,'0');}
function fmtClock(value){return new Date(value).toLocaleTimeString();}
function fmtDate(value){return new Date(value).toLocaleDateString();}
function fmtDur(value){return pad(Math.floor(value/60))+':'+pad(Math.round(value)%60);}
function h(tag,attrs,...kids){
  const el=document.createElement(tag);
  Object.entries(attrs||{}).forEach(([key,value])=>{
    if(value===null||value===undefined||value===false)return;
    if(key==='class')el.className=value;
    else if(key.startsWith('on'))el.addEventListener(key.slice(2),value);
    else el.setAttribute(key,value===true?'':value);
  });
  kids.flat(Infinity).forEach(k=>{if(k!==null&&k!==undefined&&k!==false)el.append(k instanceof Node?k:document.createTextNode(String(k)));});
  return el;
}
window.mock={calls:[],orders:{},upload:'fail',saveFailures:0,active:0,maxActive:0,
  starts:0,events:[],downloads:[],recorders:[],stopDelay:60};
class MockRecorder {
  static isTypeSupported(mime){return mime.startsWith('video/webm');}
  constructor(stream,options){this.mimeType=options.mimeType;this.state='inactive';
    this.index=mock.recorders.length;mock.recorders.push(this);}
  emit(){if(this.ondataavailable)this.ondataavailable({data:new Blob(['video-'+this.index+';'],{type:'video/webm'})});}
  start(){this.state='recording';mock.starts++;mock.active++;mock.maxActive=Math.max(mock.maxActive,mock.active);
    mock.events.push('start:'+this.index);this.interval=setInterval(()=>this.emit(),20);}
  requestData(){this.emit();}
  stop(){if(this.state==='inactive')throw new Error('Recorder already stopped');
    this.state='inactive';clearInterval(this.interval);
    setTimeout(()=>{this.emit();mock.active--;mock.events.push('stop:'+this.index);if(this.onstop)this.onstop();},mock.stopDelay);}
}
window.MediaRecorder=MockRecorder;
async function run(fn,...args){
  mock.calls.push({fn,args});
  if(fn==='lookupResi'){
    if(Object.prototype.hasOwnProperty.call(mock.orders,args[0]))return mock.orders[args[0]];
    return {order:{resi:args[0],orderSn:'ORDER-'+args[0],status:'READY_TO_SHIP',buyer:'Test',
      items:[{name:'Test product',sku:'SKU-1',qty:1}]},history:[],picking:null};
  }
  if(fn==='startVideoUpload'){
    if(mock.upload==='fail')throw new Error('Simulated offline upload');
    return {uploadId:'upload-'+args[0].clientRecordId,done:false,next:0};
  }
  if(fn==='uploadVideoChunk'){
    if(mock.upload==='no-progress')return {done:false,next:args[2]};
    return {done:true,next:args[2]+atob(args[1]).length};
  }
  if(fn==='saveRecord'){
    if(mock.saveFailures-->0)throw new Error('Simulated record-save failure');
    return {recordId:'record-test',videoUrl:'https://drive.invalid/test'};
  }
  throw new Error('Unexpected RPC '+fn);
}
HTMLAnchorElement.prototype.click=function(){mock.downloads.push({href:this.href,name:this.download});};
</script>
<script src="/recording.js"></script>
<script>
window.testReady=(async()=>{
  if(typeof restoreRecordingQueue==='function')await restoreRecordingQueue();
  else if(typeof restoreQueue==='function')await restoreQueue();
  else if(typeof initRecordingStorage==='function')await initRecordingStorage();
})();
</script>"""


def fragment_source(path):
    if path:
        return Path(path).read_text()
    source = (ROOT / "index.html").read_text()
    start = source.index("/* ============================== SCAN ")
    end = source.index("/* ============================== ADMIN ", start)
    return source[start:end]


@contextlib.contextmanager
def serve(fragment):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = (fragment if self.path == "/recording.js" else HARNESS).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript" if self.path == "/recording.js" else "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/"
    finally:
        server.shutdown()
        server.server_close()


def wait_failed(page, count=1):
    page.wait_for_function("count => ST.queue.filter(j=>j.status==='gagal').length===count", arg=count)


def ready(page, url):
    page.goto(url)
    page.evaluate("() => window.testReady")


def reject_unknown_cancelled(page):
    result = page.evaluate("""async()=>{
      mock.orders.UNKNOWN={order:null,history:[]};
      mock.orders.CANCEL1={order:{resi:'CANCEL1',status:'CANCELLED',items:[]},history:[]};
      mock.orders.CANCEL2={order:{resi:'CANCEL2',status:'Dibatalkan',items:[]},history:[]};
      for(const code of ['UNKNOWN','CANCEL1','CANCEL2'])await onScan(code);
      return {starts:mock.starts,current:ST.current,toasts:messages};
    }""")
    assert result["starts"] == 0, result
    assert result["current"] is None, result


def serial_stop_and_next_scan(page):
    result = page.evaluate("""async()=>{
      await onScan('FIRST001');
      const stopped=stopRecording();
      const next=onScan('SECOND002');
      await Promise.all([stopped,next]);
      const active=ST.current&&ST.current.resi;
      await stopRecording();
      return {active,maxActive:mock.maxActive,events:mock.events,
        videos:await Promise.all(ST.queue.map(async j=>({resi:j.resi,text:await j.blob.text()})))};
    }""")
    assert result["active"] == "SECOND002", result
    assert result["maxActive"] == 1, result
    assert result["events"] == ["start:0", "stop:0", "start:1", "stop:1"], result
    videos = {job["resi"]: job["text"] for job in result["videos"]}
    assert "video-0;" in videos["FIRST001"] and "video-1;" not in videos["FIRST001"], videos
    assert "video-1;" in videos["SECOND002"] and "video-0;" not in videos["SECOND002"], videos


def finished_survives_reload(page):
    page.evaluate("async()=>{await onScan('RECOVERY1');await stopRecording();}")
    wait_failed(page)
    before = page.evaluate("()=>({id:ST.queue[0].clientRecordId||ST.queue[0].key,size:ST.queue[0].blob.size})")
    page.reload()
    page.evaluate("()=>window.testReady")
    page.wait_for_function("()=>ST.queue.length===1")
    after = page.evaluate("()=>({id:ST.queue[0].clientRecordId||ST.queue[0].key,size:ST.queue[0].blob.size})")
    assert before == after and after["size"] > 0, (before, after)
    page.evaluate("()=>saveLocal(ST.queue[0])")
    assert page.evaluate("()=>mock.downloads.length") == 1


def interrupted_chunks_survive_reload(page):
    page.evaluate("()=>onScan('INTERRUPTED1')")
    page.wait_for_timeout(140)
    before = page.evaluate("()=>ST.current.clientRecordId||ST.current.key")
    page.reload()
    page.evaluate("()=>window.testReady")
    page.wait_for_function("()=>ST.queue.length===1")
    result = page.evaluate("""()=>({job:{id:ST.queue[0].clientRecordId||ST.queue[0].key,
      interrupted:ST.queue[0].interrupted,size:ST.queue[0].blob&&ST.queue[0].blob.size,
      status:ST.queue[0].status},uploadCalls:mock.calls.filter(c=>c.fn==='startVideoUpload').length})""")
    assert result["job"]["id"] == before, result
    assert result["job"]["interrupted"] is True and result["job"]["size"] > 0, result
    assert result["uploadCalls"] == 0, result


def no_progress_is_retryable(page):
    page.evaluate("async()=>{mock.upload='no-progress';await onScan('NOPROGRESS1');await stopRecording();}")
    wait_failed(page)
    result = page.evaluate("""()=>({size:ST.queue[0].blob.size,
      chunks:mock.calls.filter(c=>c.fn==='uploadVideoChunk').length,error:ST.queue[0].error})""")
    assert result["size"] > 0 and 0 < result["chunks"] < 20, result
    page.evaluate("()=>saveLocal(ST.queue[0])")
    assert page.evaluate("()=>mock.downloads.length") == 1
    page.evaluate("()=>{mock.upload='success';retryJob(ST.queue[0]);}")
    page.wait_for_function("()=>ST.queue[0].status==='tersimpan'")


def failed_record_save_does_not_upload_again(page):
    page.evaluate("async()=>{mock.upload='success';mock.saveFailures=1;await onScan('SAVEFAIL1');await stopRecording();}")
    wait_failed(page)
    page.evaluate("()=>retryJob(ST.queue[0])")
    page.wait_for_function("()=>ST.queue[0].status==='tersimpan'")
    calls = page.evaluate("()=>mock.calls.filter(c=>c.fn!=='lookupResi')")
    assert [call["fn"] for call in calls].count("startVideoUpload") == 1, calls
    assert [call["fn"] for call in calls].count("uploadVideoChunk") == 1, calls
    saves = [call["args"][0] for call in calls if call["fn"] == "saveRecord"]
    start = next(call["args"][0] for call in calls if call["fn"] == "startVideoUpload")
    assert len(saves) == 2 and saves[0]["clientRecordId"] == saves[1]["clientRecordId"] == start["clientRecordId"], calls


def more_than_thirty_failed_jobs_are_retained(page):
    page.evaluate("""async()=>{
      mock.stopDelay=5;
      for(let i=0;i<32;i++){await onScan('RETAIN'+String(i).padStart(3,'0'));await stopRecording();}
    }""")
    wait_failed(page, 32)
    assert page.evaluate("()=>ST.queue.length") == 32
    page.reload()
    page.evaluate("()=>window.testReady")
    page.wait_for_function("()=>ST.queue.length===32")
    assert page.evaluate("()=>ST.queue.every(job=>job.blob&&job.blob.size>0)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fragment", help="Read the recording fragment from this file instead of index.html")
    args = parser.parse_args()
    cases = [reject_unknown_cancelled, serial_stop_and_next_scan, finished_survives_reload,
             interrupted_chunks_survive_reload, no_progress_is_retryable,
             failed_record_save_does_not_upload_again, more_than_thirty_failed_jobs_are_retained]
    with serve(fragment_source(args.fragment)) as url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path="/usr/bin/chromium", headless=True,
                                             args=["--no-sandbox"])
        try:
            for case in cases:
                with browser.new_context() as context:
                    page = context.new_page()
                    errors = []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    page.set_default_timeout(10000)
                    ready(page, url)
                    case(page)
                    assert not errors, errors
                    print("PASS:", case.__name__)
        finally:
            browser.close()
    print(f"{len(cases)} recording browser checks passed")


if __name__ == "__main__":
    main()
