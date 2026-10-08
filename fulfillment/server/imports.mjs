import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { randomUUID } from 'node:crypto';
import { fail, validText, now, transaction, sourceBlocked } from './db.mjs';

const aliases = {
  tracking: ['no resi', 'nomor resi', 'nomor pelacakan', 'tracking number', 'tracking', 'resi'],
  orderNumber: ['no pesanan', 'nomor pesanan', 'order id', 'order number', 'order sn', 'ordernumber'],
  buyer: ['nama pembeli', 'username pembeli', 'username (pembeli)', 'buyer username', 'buyer'],
  recipient: ['nama penerima', 'recipient name', 'recipient'],
  sourceStatus: ['status pesanan', 'order status', 'status', 'sourcestatus'],
  name: ['nama produk', 'product name', 'nama barang', 'name'],
  sku: ['nomor referensi sku', 'sku induk', 'sku', 'sku reference no'],
  variant: ['nama variasi', 'variation name', 'variasi', 'variant'],
  quantity: ['jumlah', 'jumlah produk', 'quantity', 'qty'],
};
const key = value => String(value ?? '').toLowerCase().trim().replace(/^\ufeff/, '').replace(/[._]/g, ' ').replace(/\s+/g, ' ');
const cellText = cell => {
  if (cell.value && typeof cell.value === 'object' && 'formula' in cell.value) fail(400, 'File Excel mengandung formula. Ekspor ulang data pesanan sebagai nilai.');
  if (typeof cell.value === 'number' && /^0+$/.test(cell.numFmt || '')) return String(cell.value).padStart(cell.numFmt.length, '0');
  return cell.text;
};
export async function parseImport(file) {
  if (!file?.buffer?.length) fail(400, 'Pilih file CSV atau XLSX yang berisi pesanan.');
  let rows;
  if (/\.xlsx$/i.test(file.originalname)) {
    // Bound ZIP expansion before ExcelJS allocates workbook contents.
    const JSZip = (await import('jszip')).default;
    let zip;
    try { zip = await JSZip.loadAsync(file.buffer); } catch { fail(400, 'File XLSX tidak dapat dibaca.'); }
    let expanded = 0;
    for (const entry of Object.values(zip.files)) expanded += entry._data?.uncompressedSize || 0;
    if (expanded > 64 * 1024 * 1024 || Object.keys(zip.files).length > 1000) fail(400, 'File XLSX terlalu besar setelah diekstrak. Pecah menjadi beberapa file.');
    const workbook = new ExcelJS.Workbook();
    try { await workbook.xlsx.load(file.buffer); } catch { fail(400, 'File XLSX tidak dapat dibaca.'); }
    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount > 10001 || sheet.columnCount > 250) fail(400, 'File harus memiliki maksimal 10.000 baris dan 250 kolom.');
    rows = [];
    sheet.eachRow({ includeEmpty: true }, row => { rows.push(Array.from({ length: sheet.columnCount }, (_, index) => cellText(row.getCell(index + 1)))); });
  } else if (/\.csv$/i.test(file.originalname)) {
    const text = file.buffer.toString('utf8');
    const first = text.split(/\r?\n/, 1)[0];
    const delimiter = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
    try { rows = parse(text, { bom: true, delimiter, skip_empty_lines: true, relax_column_count: false, max_record_size: 100000 }); }
    catch { fail(400, 'CSV tidak valid. Periksa pemisah kolom dan tanda kutip.'); }
  } else fail(400, 'Format harus CSV atau XLSX.');
  if (!rows || rows.length < 2) fail(400, 'File belum memiliki baris pesanan.');
  if (rows.length > 10001) fail(400, 'Maksimal 10.000 baris per impor.');
  const headers = rows.shift().map(key);
  const columns = {};
  for (const [field, variants] of Object.entries(aliases)) columns[field] = headers.findIndex(header => variants.some(variant => key(variant) === header));
  for (const field of ['tracking', 'orderNumber', 'name', 'quantity']) {
    if (columns[field] < 0) fail(400, `Kolom wajib tidak ditemukan: ${aliases[field][0]}.`);
  }
  const orders = new Map(); let skipped = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row.every(value => !String(value ?? '').trim())) { skipped++; continue; }
    const get = field => columns[field] < 0 ? '' : String(row[columns[field]] ?? '').trim();
    const tracking = get('tracking');
    if (!tracking) { skipped++; continue; }
    const item = { name: get('name'), sku: get('sku'), variant: get('variant'), quantity: /^\d+$/.test(get('quantity')) ? Number(get('quantity')) : NaN };
    const data = { tracking, orderNumber: get('orderNumber'), buyer: get('buyer'), recipient: get('recipient'), sourceStatus: get('sourceStatus'), items: [item] };
    try { validateImportOrders([data]); } catch (error) { fail(400, `Baris ${index + 2}: ${error.message}`); }
    const existing = orders.get(tracking);
    if (existing) {
      for (const field of ['orderNumber', 'buyer', 'recipient', 'sourceStatus']) if (existing[field] !== data[field]) fail(400, `Baris ${index + 2}: data resi ${tracking} tidak konsisten.`);
      existing.items.push(item);
    } else orders.set(tracking, data);
  }
  if (!orders.size) fail(400, 'Tidak ada pesanan dengan resi untuk diimpor.');
  const result = validateImportOrders([...orders.values()]);
  const warnings = [];
  if (skipped) warnings.push(`${skipped} baris kosong atau belum memiliki resi dilewati.`);
  if (result.some(order => sourceBlocked(order.sourceStatus))) warnings.push('Pesanan dibatalkan atau belum dibayar tidak dapat diproses picker.');
  return { orders: result, rows: rows.length, skipped, warnings };
}
export function validateImportOrders(input) {
  if (!Array.isArray(input) || !input.length || input.length > 10000) fail(400, 'Impor harus berisi 1–10.000 pesanan.');
  const seen = new Set(); let totalItems = 0;
  return input.map(value => {
    if (!value || typeof value !== 'object') fail(400, 'Format pesanan tidak valid.');
    const order = {
      tracking: validText(value.tracking, 'Resi', 120), orderNumber: validText(value.orderNumber, 'Nomor pesanan', 120),
      buyer: validText(value.buyer ?? '', 'Pembeli', 200, false), recipient: validText(value.recipient ?? '', 'Penerima', 200, false),
      sourceStatus: validText(value.sourceStatus ?? '', 'Status pesanan', 100, false), items: [],
    };
    if (seen.has(order.tracking)) fail(400, `Resi ${order.tracking} muncul lebih dari satu kali. Gabungkan barang menjadi satu pesanan.`);
    seen.add(order.tracking);
    if (!Array.isArray(value.items) || !value.items.length || value.items.length > 1000) fail(400, 'Pesanan harus berisi 1–1.000 barang.');
    totalItems += value.items.length;
    if (totalItems > 10000) fail(400, 'Maksimal 10.000 barang per impor.');
    order.items = value.items.map(item => {
      if (!item || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 100000) fail(400, 'Jumlah barang harus bilangan bulat positif, maksimal 100.000.');
      return { name: validText(item.name, 'Nama barang', 500), sku: validText(item.sku ?? '', 'SKU', 150, false),
        variant: validText(item.variant ?? '', 'Variasi', 200, false), quantity: item.quantity };
    });
    return order;
  });
}
export async function confirmImport(db, input) {
  const orders = validateImportOrders(input);
  return transaction(db, async db => {
    let imported = 0, updated = 0;
    for (const order of orders) {
      const existing = (await db.query('SELECT * FROM fulfill.orders WHERE tracking = $1', [order.tracking])).rows[0];
      const serialized = JSON.stringify(order.items);
      if (!existing) {
        const timestamp = now();
        await db.query(`INSERT INTO fulfill.orders (id,tracking,order_number,buyer,recipient,source_status,status,items,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,'NEW',$7,$8,$9)`, [randomUUID(), order.tracking, order.orderNumber, order.buyer, order.recipient, order.sourceStatus, serialized, timestamp, timestamp]);
        imported++; continue;
      }
      const changed = existing.order_number !== order.orderNumber || existing.buyer !== order.buyer || existing.recipient !== order.recipient || existing.source_status !== order.sourceStatus || existing.items !== serialized;
      if (existing.status === 'PACKING') fail(409, `Resi ${order.tracking} sedang direkam. Selesaikan packing dahulu.`);
      if (existing.status === 'PACKED' && changed) fail(409, `Resi ${order.tracking} sudah dipacking dan tidak dapat diubah.`);
      if (changed) {
        const reset = existing.items !== serialized || sourceBlocked(order.sourceStatus) || existing.order_number !== order.orderNumber;
        await db.query(`UPDATE fulfill.orders SET order_number=$1,buyer=$2,recipient=$3,source_status=$4,items=$5,status=$6,picked_by=$7,picked_at=$8,picked_input_version=$9,version=version+1,updated_at=$10 WHERE id=$11`, [order.orderNumber, order.buyer, order.recipient, order.sourceStatus, serialized, reset ? 'NEW' : existing.status,
            reset ? null : existing.picked_by, reset ? null : existing.picked_at, reset ? null : existing.picked_input_version, now(), existing.id]);
      }
      updated++;
    }
    return { imported, updated };
  });
}
