"""Full-stack smoke tests: real Express/SQLite + React + Chromium MediaRecorder.

Run `npm run build && npm run test:browser` after installing Python Playwright
and Chromium. Only the Google Drive network adapter is replaced. Fixtures and
video bytes are isolated from production; the temporary database is removed.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import select
import shutil
import subprocess
import sys
import time
import traceback

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = Path(os.environ.get("BROWSER_ARTIFACTS", "/tmp/fulfill-ui"))
PASSWORD = "Browser test only 2026!"  # Isolated fixture accounts only.
CSV = """No. Pesanan,No. Resi,Username (Pembeli),Nama Penerima,Status Pesanan,Nama Produk,Nama Variasi,SKU,Jumlah
ORDER-E2E-001,SPX-E2E-001,pembeli_satu,Ayu Lestari,Perlu Dikirim,Kaos Katun Premium,Hitam L,KAOS-H-L,2
ORDER-E2E-001,SPX-E2E-001,pembeli_satu,Ayu Lestari,Perlu Dikirim,Tote Bag Kanvas,Natural,TOTE-N,1
ORDER-E2E-002,SPX-E2E-002,pembeli_dua,Budi Santoso,Perlu Dikirim,Kemeja Linen,Putih M,LINEN-W-M,1
ORDER-E2E-003,SPX-E2E-003,pembeli_tiga,Citra Dewi,Perlu Dikirim,Celana Chino,Krem 32,CHINO-K-32,1
"""

passed = []
errors = []


def case(name):
    passed.append(name)
    print(f"PASS {len(passed):02d} {name}", flush=True)


def fixture_line(process, timeout=15):
    if not select.select([process.stdout], [], [], timeout)[0]:
        raise AssertionError("Fixture server did not respond within timeout")
    line = process.stdout.readline().strip()
    if not line:
        raise AssertionError(f"Fixture server stopped (exit {process.poll()})")
    return line


def api(context, path, method="get", data=None, headers=None, expected=200):
    response = getattr(context.request, method)(path, data=data, headers=headers)
    assert response.status == expected, (path, response.status, response.text())
    return response.json()


def login(page, username, role):
    page.goto("/login")
    page.get_by_label("Username", exact=True).fill(username)
    page.get_by_label("Password", exact=True).fill(PASSWORD)
    page.get_by_role("button", name="Masuk ke ruang kerja").click()
    page.wait_for_url(f"**/{role}")


def no_horizontal_overflow(page):
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), "Page overflows viewport"


def local_backups(page):
    return page.evaluate("""async () => {
      const instance = await new Promise((resolve, reject) => {
        const request = indexedDB.open('fulfill-video-backups-v1');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (!instance.objectStoreNames.contains('jobs')) { instance.close(); return []; }
      const jobs = await new Promise((resolve, reject) => {
        const request = instance.transaction('jobs').objectStore('jobs').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const results = [];
      for (const job of jobs) {
        const chunks = await new Promise((resolve, reject) => {
          const request = instance.transaction('chunks').objectStore('chunks').index('jobId').getAll(job.id);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        chunks.sort((left, right) => left.sequence - right.sequence);
        const blob = new Blob(chunks.map(item => item.blob));
        const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
        results.push({ ...job, actualBytes: blob.size, chunkCount: chunks.length,
          sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') });
      }
      instance.close();
      return results;
    }""")


def wait_backup(page, predicate, timeout=15):
    deadline = time.monotonic() + timeout
    last = []
    while time.monotonic() < deadline:
        last = local_backups(page)
        if predicate(last):
            return last
        page.wait_for_timeout(100)
    raise AssertionError(f"Recording backup state not reached: {last}")


def main():
    if not (ROOT / "dist/index.html").exists():
        raise SystemExit("Run npm run build before npm run test:browser.")
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    process = None
    page = None
    with (ARTIFACTS / "fixture.log").open("w") as fixture_log:
        try:
            process = subprocess.Popen(
                ["node", "tests/fixture-server.mjs"], cwd=ROOT,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=fixture_log,
                text=True, bufsize=1,
            )
            ready = fixture_line(process)
            assert re.fullmatch(r"READY \d+", ready), ready
            base = "http://127.0.0.1:" + ready.split()[1]
            with sync_playwright() as playwright:
                executable = os.environ.get("BROWSER_EXECUTABLE") or shutil.which("chromium") or shutil.which("chromium-browser")
                browser = playwright.chromium.launch(
                    executable_path=executable, headless=True,
                    args=["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
                )
                def context(**kwargs):
                    result = browser.new_context(base_url=base, **kwargs)
                    result.on("page", lambda opened: opened.on("pageerror", lambda error: errors.append(str(error))))
                    result.set_default_timeout(12_000)
                    return result

                admin = context(viewport={"width": 1440, "height": 1040})
                page = admin.new_page()
                page.goto("/login")
                expect(page.get_by_role("heading", name="Selamat datang kembali.")).to_be_visible()
                no_horizontal_overflow(page)
                page.screenshot(path=str(ARTIFACTS / "login.png"), full_page=True)
                page.get_by_label("Username", exact=True).fill("admin-test")
                page.get_by_label("Password", exact=True).fill("incorrect password")
                page.get_by_role("button", name="Masuk ke ruang kerja").click()
                expect(page.get_by_role("alert")).to_contain_text("Username atau kata sandi salah")
                case("Login rejects an incorrect password with a visible message")

                login(page, "admin-test", "admin")
                expect(page.get_by_role("heading", name="Ringkasan operasional.")).to_be_visible()
                case("Admin session logs in and loads the real dashboard")

                page.get_by_role("button", name="Impor pesanan", exact=True).click()
                dialog = page.get_by_role("dialog")
                dialog.locator('input[type="file"]').set_input_files({"name": "shopee-test.csv", "mimeType": "text/csv", "buffer": CSV.encode()})
                expect(dialog.get_by_text("4 baris dibaca · 3 pesanan · 0 dilewati")).to_be_visible()
                expect(dialog.get_by_text("2 × Kaos Katun Premium · Hitam L")).to_be_visible()
                expect(dialog.get_by_text("1 × Tote Bag Kanvas · Natural")).to_be_visible()
                before = api(admin, "/api/orders")
                assert before["total"] == 0, "Preview must not import before confirmation"
                case("Shopee CSV preview groups multiple product rows without saving prematurely")
                dialog.get_by_role("button", name="Impor 3 pesanan").click()
                expect(page.get_by_role("status")).to_contain_text("3 pesanan baru ditambahkan")
                orders = api(admin, "/api/orders")["orders"]
                assert len(orders) == 3
                order = next(row for row in orders if row["tracking"] == "SPX-E2E-001")
                assert len(order["items"]) == 2 and sum(item["quantity"] for item in order["items"]) == 3
                case("Confirmed import saves three orders with exact item variants and quantities")
                page.screenshot(path=str(ARTIFACTS / "admin.png"), full_page=True)
                no_horizontal_overflow(page)

                page.get_by_role("navigation", name="Navigasi admin").get_by_role("button", name="Tim gudang").click()
                for role, name in [("picker", "Sari Picker"), ("packer", "Dimas Packer")]:
                    page.get_by_role("button", name="Tambah anggota", exact=True).click()
                    dialog = page.get_by_role("dialog")
                    dialog.get_by_label("Nama lengkap", exact=True).fill(name)
                    dialog.get_by_label("Username", exact=True).fill(role + "-test")
                    dialog.get_by_label("Peran", exact=True).select_option(role)
                    dialog.get_by_label("Password", exact=True).fill(PASSWORD)
                    dialog.get_by_role("button", name="Buat akun").click()
                    expect(dialog).not_to_be_visible()
                    expect(page.get_by_role("cell", name=role + "-test", exact=True)).to_be_visible()
                assert len(api(admin, "/api/users")["users"]) == 3
                case("Admin creates separate picker and packer accounts through the UI")

                picker = context(viewport={"width": 375, "height": 812}, is_mobile=True, has_touch=True)
                page = picker.new_page()
                login(page, "picker-test", "picker")
                no_horizontal_overflow(page)
                api(picker, "/api/users", expected=403)
                page.goto("/admin")
                page.wait_for_url("**/picker")
                case("Picker role is isolated from admin APIs and admin pages")

                page.get_by_label("Nomor resi", exact=True).fill("NOT-IMPORTED")
                page.get_by_role("button", name="Cari pesanan", exact=True).click()
                expect(page.get_by_role("alert")).to_contain_text("Resi belum ditemukan")
                case("Missing tracking number shows a useful picker error")

                for tracking in ["SPX-E2E-001", "SPX-E2E-002"]:
                    page.get_by_label("Nomor resi", exact=True).fill(tracking)
                    page.get_by_role("button", name="Cari pesanan", exact=True).click()
                    expect(page.get_by_role("heading", name=tracking, exact=True)).to_be_visible()
                    complete = page.get_by_role("button", name="Selesai picking", exact=True)
                    expect(complete).to_be_disabled()
                    boxes = page.get_by_role("checkbox")
                    for index in range(boxes.count()):
                        boxes.nth(index).check()
                        if index < boxes.count() - 1:
                            expect(complete).to_be_disabled()
                    expect(complete).to_be_enabled()
                    if tracking.endswith("001"):
                        page.screenshot(path=str(ARTIFACTS / "picker.png"), full_page=True)
                        no_horizontal_overflow(page)
                    complete.click()
                    expect(page.get_by_role("status")).to_contain_text("Pemeriksaan tersimpan")
                    assert api(picker, f"/api/orders/{tracking}")["order"]["status"] == "READY"
                    expect(page.get_by_role("checkbox").first).to_be_disabled()
                case("Mobile picker must check every item before two orders become READY")

                if "--until-picker" not in sys.argv:
                    test_packing(context, admin, picker, process)
                assert not errors, f"Uncaught browser JavaScript errors: {errors}"
                case("No uncaught JavaScript errors across all tested screens")
                browser.close()
            print(json.dumps({"passed": len(passed), "checks": passed, "artifacts": str(ARTIFACTS)}, ensure_ascii=False), flush=True)
        except Exception:
            if page:
                try:
                    page.screenshot(path=str(ARTIFACTS / "failure.png"), full_page=True)
                    (ARTIFACTS / "failure.html").write_text(page.content())
                except Exception:
                    pass
            traceback.print_exc()
            raise
        finally:
            if process:
                process.terminate()
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def test_packing(context, admin, picker, process):
    packer = context(viewport={"width": 1440, "height": 1040}, permissions=["camera"])
    page = packer.new_page()
    try:
        login(page, "packer-test", "packer")
        tracking = page.get_by_label("Nomor resi", exact=True)
        expect(tracking).to_be_disabled()
        page.get_by_role("button", name="Aktifkan kamera", exact=True).click()
        expect(tracking).to_be_enabled()
        page.wait_for_function("document.querySelector('video').readyState >= 2")
        assert page.evaluate("document.querySelector('video').srcObject.getVideoTracks()[0].readyState") == "live"
        no_horizontal_overflow(page)
        case("Packer requires a live camera before enabling the tracking scanner")

        tracking.fill("SPX-E2E-003")
        tracking.press("Enter")
        expect(page.get_by_role("alert")).to_contain_text("Hanya pesanan yang telah diperiksa picker")
        assert api(admin, "/api/orders/SPX-E2E-003")["order"]["status"] == "NEW"
        assert api(admin, "/api/recordings")["recordings"] == []
        case("Packer cannot start a recording before picker completion")

        def record(resi):
            field = page.get_by_label("Nomor resi", exact=True)
            expect(field).to_be_enabled()
            field.fill(resi)
            field.press("Enter")
            expect(page.get_by_text("Rekaman sedang berjalan", exact=True)).to_be_visible()
            expect(field).to_be_enabled()  # Scanner accepts STOP or the same resi while recording.
            expect(page.get_by_role("heading", name=resi, exact=True)).to_be_visible()
            assert api(admin, f"/api/orders/{resi}")["order"]["status"] == "PACKING"
            return wait_backup(page, lambda rows: len(rows) == 1 and rows[0]["chunkCount"] >= 2 and rows[0]["actualBytes"] > 1000)[0]

        first = record("SPX-E2E-001")
        expect(page.get_by_text("Kaos Katun Premium", exact=True)).to_be_visible()
        expect(page.get_by_text("Tote Bag Kanvas", exact=True)).to_be_visible()
        page.screenshot(path=str(ARTIFACTS / "packer.png"), full_page=True)
        page.get_by_role("button", name="Keluar", exact=True).click()
        expect(page.get_by_role("alert")).to_contain_text("Selesaikan rekaman")
        assert page.url.endswith("/packer")
        case("Scanning starts a real MediaRecorder video, shows every product, and prevents logout during capture")
        page.get_by_label("Nomor resi", exact=True).fill("STOP")
        page.get_by_label("Nomor resi", exact=True).press("Enter")
        expect(page.get_by_role("status")).to_contain_text("Resi SPX-E2E-001 selesai dikemas")
        assert api(admin, "/api/orders/SPX-E2E-001")["order"]["status"] == "PACKED"
        assert local_backups(page) == []
        recordings = api(admin, "/api/recordings")["recordings"]
        first_saved = next(row for row in recordings if row["id"] == first["id"])
        assert first_saved["status"] == "SAVED" and first_saved["bytes"] > 1000 and first_saved["duration"] > 0
        complete_video = admin.request.get(f"/api/recordings/{first['id']}/video")
        assert complete_video.status == 200 and complete_video.body()[:4] == bytes([0x1A, 0x45, 0xDF, 0xA3])
        assert len(complete_video.body()) == first_saved["bytes"]
        (ARTIFACTS / "packing-recorded.webm").write_bytes(complete_video.body())
        case("Successful Drive confirmation saves a nonempty WebM and sets PACKED before clearing browser backup")

        record("SPX-E2E-002")
        process.stdin.write("fail-next-upload\n")
        process.stdin.flush()
        assert fixture_line(process) == "CONTROL fail-next-upload"
        page.get_by_role("button", name="Selesai & simpan", exact=True).click()
        expect(page.get_by_role("alert")).to_contain_text("Google Drive sedang tidak tersedia")
        failed = wait_backup(page, lambda rows: len(rows) == 1 and rows[0]["state"] == "failed")[0]
        assert failed["actualBytes"] > 1000 and not failed["interrupted"]
        assert api(admin, "/api/orders/SPX-E2E-002")["order"]["status"] == "PACKING"
        expect(page.get_by_label("Nomor resi", exact=True)).to_be_disabled()
        page.screenshot(path=str(ARTIFACTS / "packer-upload-retry.png"), full_page=True)
        case("Drive failure leaves order PACKING and retains the complete video in IndexedDB")

        page.once("dialog", lambda dialog: dialog.accept())
        page.reload()
        expect(page.get_by_role("button", name="Coba unggah", exact=True)).to_be_enabled()
        recovered = local_backups(page)[0]
        assert recovered["id"] == failed["id"]
        assert recovered["actualBytes"] == failed["actualBytes"] and recovered["sha256"] == failed["sha256"]
        assert not recovered["interrupted"]
        page.get_by_role("button", name="Coba unggah", exact=True).click()
        expect(page.get_by_role("status")).to_contain_text("Resi SPX-E2E-002 selesai dikemas")
        assert api(admin, "/api/orders/SPX-E2E-002")["order"]["status"] == "PACKED"
        assert local_backups(page) == []
        case("After reload, upload retry uses byte-identical persisted video and safely completes packing")

        order = api(picker, "/api/orders/SPX-E2E-003")["order"]
        api(picker, "/api/picking/SPX-E2E-003/complete", "post", {"checked": [0], "version": order["version"]})
        page.get_by_role("button", name="Aktifkan kamera", exact=True).click()
        interrupted = record("SPX-E2E-003")
        page.once("dialog", lambda dialog: dialog.accept())
        page.reload()
        expect(page.get_by_role("button", name="Simpan bukti terputus", exact=True)).to_be_enabled()
        partial = local_backups(page)[0]
        assert partial["id"] == interrupted["id"] and partial["interrupted"] and partial["actualBytes"] > 1000
        page.get_by_role("button", name="Simpan bukti terputus", exact=True).click()
        expect(page.get_by_role("status")).to_contain_text("packing belum selesai")
        assert api(admin, "/api/orders/SPX-E2E-003")["order"]["status"] == "READY"
        assert local_backups(page) == []
        interrupted_server = next(row for row in api(admin, "/api/recordings")["recordings"] if row["id"] == interrupted["id"])
        assert interrupted_server["status"] == "INTERRUPTED"
        case("Reload during capture recovers partial evidence and returns the order to READY, never PACKED")

        admin_page = admin.new_page()
        admin_page.goto("/admin?tab=recordings")
        admin_page.get_by_role("textbox", name="Cari bukti packing", exact=True).fill("SPX-E2E-001")
        expect(admin_page.locator("tbody tr")).to_have_count(1)
        admin_page.get_by_role("button", name="Lihat", exact=True).click()
        dialog = admin_page.get_by_role("dialog")
        expect(dialog.locator("video")).to_be_visible()
        admin_page.wait_for_function("document.querySelector('dialog video')?.readyState >= 2")
        dialog.locator("video").evaluate("video => video.play()")
        admin_page.wait_for_function("document.querySelector('dialog video').currentTime > 0")
        range_response = admin.request.get(f"/api/recordings/{first['id']}/video", headers={"Range": "bytes=0-31"})
        assert range_response.status == 206 and len(range_response.body()) == 32
        assert range_response.headers["content-range"].startswith("bytes 0-31/")
        assert range_response.body() == complete_video.body()[:32]
        api(picker, f"/api/recordings/{first['id']}/video", expected=403)
        admin_page.screenshot(path=str(ARTIFACTS / "admin-video-playback.png"), full_page=True)
        case("Admin can find and play the actual evidence; HTTP range seeking works and picker access is denied")
    except Exception:
        page.screenshot(path=str(ARTIFACTS / "failure-packer.png"), full_page=True)
        (ARTIFACTS / "failure-packer.html").write_text(page.content())
        raise


if __name__ == "__main__":
    main()
