#!/usr/bin/env python3
"""Full-page browser checks with offline Apps Script HTTP responses.

Run: python tests/fulfillment-browser.py
Requires Python Playwright and /usr/bin/chromium. The real HTML, DOM, CSV reader,
IndexedDB and MediaRecorder run in Chromium; a fake camera provides video frames.
Google Apps Script/Sheets/Drive responses are mocked, so these checks do not prove
deployment permissions or a real upload. All non-local network access is blocked.
"""

import base64
import contextlib
import copy
import functools
import http.server
import json
from pathlib import Path
import threading

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BACKEND_URL = "https://script.google.com/macros/s/TEST/exec"
STATION_KEY = "test-station-key"
PICKER = {"id": "picker-1", "name": "Siti Picker", "code": "PICK01", "active": True}
PACKER = {"id": "packer-1", "name": "Budi Packer", "code": "PACK01"}
ORDER = {
    "resi": "SPX000001", "orderSn": "ORDER0001", "buyer": "customer",
    "recipient": "Nama Penerima", "status": "READY_TO_SHIP", "orderVersion": "version-1",
    "items": [
        {"name": "Serum, wajah", "variation": "30 ml", "sku": "SER30", "qty": 2},
        {"name": "Sabun", "variation": "100 g", "sku": "SAB100", "qty": 1},
    ],
}
CSV = ("No. Resi,No. Pesanan,Username (Pembeli),Nama Penerima,Status Pesanan,Nama Produk,Nama Variasi,SKU,Jumlah\r\n"
       'SPX000001,ORDER0001,customer,Nama Penerima,READY_TO_SHIP,"Serum, wajah",30 ml,SER30,2\r\n'
       'SPX000001,ORDER0001,customer,Nama Penerima,READY_TO_SHIP,Sabun,100 g,SAB100,1\r\n')


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


@contextlib.contextmanager
def server():
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_port}"
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join()


class Backend:
    """A contract fixture, not a replacement for the Code.gs security tests."""

    def __init__(self):
        self.calls = []
        self.orders = {ORDER["resi"]: copy.deepcopy(ORDER)}
        self.pickers = [copy.deepcopy(PICKER)]
        self.picking = {}
        self.picker_expired = False
        self.reject_complete = False
        self.hold_lookup = False
        self.pending = []
        self.uploads = {}
        self.records = []
        self.failures = []

    def route(self, route):
        request = route.request
        if request.url.startswith("http://127.0.0.1:"):
            route.continue_()
            return
        if request.url != BACKEND_URL:
            # Native CSV is used; optional Excel/barcode CDN scripts are unnecessary.
            route.fulfill(status=200, body="", content_type="text/plain")
            return
        try:
            payload = request.post_data_json
            assert payload["key"] == STATION_KEY
            self.calls.append(payload)
            if payload["fn"] == "pickerLookup" and self.hold_lookup:
                self.pending.append(route)
                return
            try:
                envelope = {"ok": True, "result": self.dispatch(payload["fn"], payload["args"])}
            except ValueError as error:
                envelope = {"ok": False, "error": str(error)}
        except Exception as error:
            self.failures.append(str(error))
            envelope = {"ok": False, "error": str(error)}
        self.respond(route, envelope)

    @staticmethod
    def respond(route, envelope):
        route.fulfill(status=200, content_type="application/json", body=json.dumps(envelope),
                      headers={"Access-Control-Allow-Origin": "*"})

    def dispatch(self, fn, args):
        if fn.startswith("admin") and fn != "adminLogin":
            if not args or args[0] != "admin-token":
                raise ValueError("SESSION: Sesi admin berakhir.")
        if fn.startswith("picker") and fn not in ("pickerLogin", "pickerLogout"):
            if self.picker_expired or args[0] != "picker-token":
                raise ValueError("SESSION: Sesi picker berakhir.")
        if fn == "getBootstrap":
            return {"packers": [PACKER], "maxSec": 180, "bitrate": 700000, "shopeeConnected": False}
        if fn == "adminLogin":
            if args != ["123456"]:
                raise ValueError("PIN admin salah.")
            return "admin-token"
        if fn == "adminGetSettings":
            return {"maxSec": 180, "bitrate": 700000, "syncDays": 7, "sheetUrl": "#",
                    "folderUrl": "#", "webAppUrl": BACKEND_URL, "stationKey": STATION_KEY,
                    "shopee": {"env": "live", "partnerId": "", "connected": False, "autoSync": False}}
        if fn == "listOrders":
            return {"total": len(self.orders), "orders": list(self.orders.values())}
        if fn == "adminImportOrders":
            for order in args[1]:
                self.orders[order["resi"]] = {**order, "orderVersion": "import-version"}
            return {"saved": len(args[1])}
        if fn == "adminGetPickers":
            return self.pickers
        if fn == "adminSavePicker":
            picker = args[1]
            assert picker["pin"] == "2468", picker
            self.pickers = [{"id": "picker-1", "name": picker["name"], "code": picker["code"], "active": True}]
            return self.pickers
        if fn == "pickerLogin":
            if args != ["PICK01", "2468"]:
                raise ValueError("Kode atau PIN picker salah.")
            self.picker_expired = False
            return {"token": "picker-token", "picker": self.pickers[0]}
        if fn == "pickerLogout":
            return {"ok": True}
        if fn in ("pickerLookup", "lookupResi"):
            resi = args[-1].strip().upper()
            return {"order": self.orders.get(resi), "picking": self.picking.get(resi), "history": []}
        if fn == "pickerComplete":
            if self.reject_complete:
                raise ValueError("Data pesanan berubah. Scan ulang resi dan periksa semua barang kembali.")
            order = self.orders[args[1]]
            assert args[2] == list(range(len(order["items"]))), args
            assert args[3] == order["orderVersion"], args
            self.picking[args[1]] = {"complete": True, "pickerName": PICKER["name"], "completedAt": "2026-10-07T08:00:00Z"}
            return self.picking[args[1]]
        if fn == "startVideoUpload":
            meta = args[0]
            assert meta["size"] > 0 and meta["resi"] in self.orders, meta
            upload_id = "upload-" + str(len(self.uploads) + 1)
            self.uploads[upload_id] = {"meta": meta, "bytes": bytearray()}
            return {"uploadId": upload_id, "done": False, "next": 0}
        if fn == "uploadVideoChunk":
            upload = self.uploads[args[0]]
            assert args[2] == len(upload["bytes"]), args[2]
            upload["bytes"].extend(base64.b64decode(args[1], validate=True))
            size = len(upload["bytes"])
            assert size <= upload["meta"]["size"]
            return {"done": size == upload["meta"]["size"], "next": size}
        if fn == "saveRecord":
            self.records.append(args[0])
            return {"recordId": "record-1", "videoUrl": "https://drive.google.com/file/d/MOCK/view"}
        raise AssertionError("Unexpected RPC: " + fn)


@contextlib.contextmanager
def app(browser, base_url, backend, filename="index.html", mobile=False):
    with browser.new_context(viewport={"width": 390 if mobile else 1440, "height": 844 if mobile else 1000},
                             permissions=["camera"], device_scale_factor=1) as context:
        context.route("**/*", backend.route)
        context.add_init_script("""(() => {
            const values = VALUES;
            localStorage.setItem('pr_backendUrl', values.url);
            localStorage.setItem('pr_backendKey', values.key);
        })();""".replace("VALUES", json.dumps({"url": BACKEND_URL, "key": STATION_KEY})))
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.set_default_timeout(10000)
        page.goto(base_url + "/" + filename, wait_until="networkidle")
        yield page
        assert not errors, errors
        assert not backend.failures, backend.failures


def login_picker(page, pin="2468"):
    page.locator("#pickerCode").fill("PICK01")
    page.locator("#pickerPin").fill(pin)
    page.locator("#loginButton").click()


def lookup(page, resi="SPX000001"):
    page.locator("#resiInput").fill(resi)
    page.locator("#lookupButton").click()


def all_items_checked(page):
    boxes = page.locator("#itemList input[type=checkbox]")
    expect(boxes).to_have_count(2)
    expect(page.locator("#completeButton")).to_be_disabled()
    boxes.nth(0).check()
    expect(page.locator("#completeButton")).to_be_disabled()
    boxes.nth(1).check()
    expect(page.locator("#completeButton")).to_be_enabled()


def admin_import_then_picker_then_recording(browser, url):
    backend = Backend()
    backend.orders = {}
    backend.pickers = []
    with app(browser, url, backend) as page:
        page.locator("#btnPickAdmin").click()
        page.locator("#loginPin").fill("123456")
        page.locator("#loginAdminGo").click()
        expect(page.locator("#roleBadge")).to_have_text("Administrator")
        page.locator('[data-mode="admin"]').click()
        page.locator('[data-tab="orders"]').click()
        page.locator("#importFile").set_input_files({"name": "shopee.csv", "mimeType": "text/csv", "buffer": CSV.encode()})
        expect(page.locator("#importPreview")).to_contain_text("1 resi unik")
        page.locator("#importPreview button").click()
        expect(page.locator("#importPreview button")).to_have_text("1 pesanan diimpor")
        assert len(backend.orders) == 1 and len(backend.orders["SPX000001"]["items"]) == 2
        assert backend.orders["SPX000001"]["items"][0] == ORDER["items"][0]
        page.locator('[data-tab="pickers"]').click()
        page.locator("#piName").fill(PICKER["name"])
        page.locator("#piCode").fill(PICKER["code"])
        page.locator("#piPin").fill("2468")
        page.locator("#btnPiSave").click()
        expect(page.locator("#piRows")).to_contain_text(PICKER["name"])
        expect(page.locator("#piPin")).to_have_value("")
    with app(browser, url, backend, "picker.html", mobile=True) as page:
        login_picker(page)
        expect(page.locator("#pickerName")).to_have_text(PICKER["name"])
        lookup(page)
        expect(page.locator("#itemCount")).to_have_text("2 jenis · 3 unit")
        expect(page.locator("#itemList")).to_contain_text("SER30")
        all_items_checked(page)
        page.locator("#completeButton").click()
        expect(page.locator("#completeStatus")).to_be_visible()
        expect(page.locator("#completedBy")).to_contain_text(PICKER["name"])
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    with app(browser, url, backend) as page:
        page.locator("#btnPickUser").click()
        expect(page.locator('[data-mode="admin"]')).to_be_hidden()
        expect(page.locator("#drop")).to_be_hidden()
        # Verifies token-less attempts are surfaced as failures by the client.
        denied = page.evaluate("async () => { try { await run('adminImportOrders', null, []); return ''; } catch(e) { return e.message; } }")
        assert "SESSION" in denied
        page.locator("#packerSelect").select_option(PACKER["id"])
        page.wait_for_function("() => ST.stream && camVideo.readyState >= 2")
        page.locator("#scan").fill("SPX000001")
        page.locator("#scan").press("Enter")
        page.wait_for_function("() => ST.recorder && ST.recorder.state === 'recording'")
        expect(page.locator("#orderItems")).to_contain_text("Serum, wajah")
        page.wait_for_timeout(1200)  # Record real frames from Chromium's fake camera.
        page.locator("#btnStop").click()
        try:
            page.wait_for_function("() => ST.queue.some(job => job.status === 'tersimpan')")
        except Exception as error:
            detail = page.evaluate("() => ST.queue.map(job => ({status:job.status,error:job.error,size:job.blob?.size}))")
            raise AssertionError({"queue": detail, "mockErrors": backend.failures,
                                  "calls": [call['fn'] for call in backend.calls]}) from error
        assert len(backend.records) == 1 and len(backend.uploads) == 1
        upload = next(iter(backend.uploads.values()))
        assert len(upload["bytes"]) == upload["meta"]["size"] > 1000
        assert upload["bytes"][:4] == b"\x1aE\xdf\xa3", "Expected a real WebM container"
        assert backend.records[0]["resi"] == "SPX000001"
        assert backend.records[0]["packerId"] == PACKER["id"]
        assert backend.records[0]["clientRecordId"] == upload["meta"]["clientRecordId"]


def picker_errors_and_stale_completion(browser, url):
    backend = Backend()
    with app(browser, url, backend, "picker.html", mobile=True) as page:
        login_picker(page, "0000")
        expect(page.locator("#globalMessage")).to_contain_text("PIN picker salah")
        expect(page.locator("#loginCard")).to_be_visible()
        login_picker(page)
        lookup(page, "UNKNOWN001")
        expect(page.locator("#globalMessage")).to_contain_text("belum ditemukan")
        expect(page.locator("#orderCard")).to_be_hidden()
        lookup(page)
        all_items_checked(page)
        backend.reject_complete = True
        page.locator("#completeButton").click()
        expect(page.locator("#globalMessage")).to_contain_text("Data pesanan berubah")
        expect(page.locator("#orderCard")).to_be_hidden()
        expect(page.locator("#completeStatus")).to_be_hidden()
        backend.reject_complete = False
        lookup(page)
        expect(page.locator("#itemList input:checked")).to_have_count(0)
        backend.picker_expired = True
        lookup(page)
        expect(page.locator("#loginCard")).to_be_visible()
        expect(page.locator("#globalMessage")).to_contain_text("Sesi berakhir")
        assert page.evaluate("sessionStorage.getItem('pr_pickerToken')") is None
        login_picker(page)
        lookup(page)
        expect(page.locator("#orderCard")).to_be_visible()
        expect(page.locator("#itemList input:checked")).to_have_count(0)


def picker_late_response_after_logout(browser, url):
    backend = Backend()
    with app(browser, url, backend, "picker.html") as page:
        login_picker(page)
        expect(page.locator("#workspace")).to_be_visible()
        backend.hold_lookup = True
        lookup(page)
        page.wait_for_function("document.getElementById('lookupButton').disabled")
        page.locator("#logoutButton").click()
        expect(page.locator("#loginCard")).to_be_visible()
        assert len(backend.pending) == 1
        backend.respond(backend.pending.pop(), {"ok": True, "result": {"order": ORDER, "picking": None}})
        expect(page.locator("#workspace")).to_be_hidden()
        expect(page.locator("#orderCard")).to_be_hidden()
        backend.hold_lookup = False
        login_picker(page)
        lookup(page)
        expect(page.locator("#orderCard")).to_be_visible()


def main():
    cases = [admin_import_then_picker_then_recording, picker_errors_and_stale_completion,
             picker_late_response_after_logout]
    with server() as url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path="/usr/bin/chromium", headless=True,
            args=["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])
        try:
            for case in cases:
                case(browser, url)
                print("PASS:", case.__name__)
        finally:
            browser.close()
    print(f"{len(cases)} full-page browser checks passed (mocked Apps Script/Drive; real MediaRecorder)")


if __name__ == "__main__":
    main()
