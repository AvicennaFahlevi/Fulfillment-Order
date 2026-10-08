const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const context = vm.createContext({cleanCode:v=>String(v||'').replace(/\s/g,'').toUpperCase()});
vm.runInContext(html.slice(html.indexOf('const COLS ='), html.indexOf("$('importFile').addEventListener")), context);
const parse = csv => JSON.parse(JSON.stringify(context.groupShopeeRows(context.parseCsv(csv))));
const headers = 'No. Resi,No. Pesanan,Nama Produk,Nama Variasi,Nomor Referensi SKU,Jumlah';
test('Shopee CSV retains leading zeros, multiple items, commas and quoted newlines', () => {
 const r = parse(headers+'\n00012345,000099,"Serum, wajah",30ml,SK01,2\n00012345,000099,"Sunscreen\nSPF 50",50ml,SK02,1');
 assert.equal(r.orders.length,1);assert.equal(r.orders[0].resi,'00012345');assert.equal(r.orders[0].orderSn,'000099');
 assert.equal(r.orders[0].items.length,2);assert.equal(r.orders[0].items[0].qty,2);assert.equal(r.orders[0].items[1].name,'Sunscreen\nSPF 50');
});
test('semicolon/BOM exports and skipped empty tracking numbers are reported',()=>{
 const r=parse('\ufeff'+headers.replaceAll(',',';')+'\r\nSPX123;SN123;Produk;Merah;SKU01;3\r\n;SN124;Lain;;SKU02;1');
 assert.equal(r.skipped,1);assert.equal(r.orders[0].items[0].qty,3);
});
test('reject missing product columns, invalid quantities and conflicting orders before import',()=>{
 assert.throws(()=>parse('No. Resi,No. Pesanan\nSPX123,SN123'),/Kolom wajib/);
 for(const qty of ['-2','0','1.5','abc']) assert.throws(()=>parse(headers+'\nSPX123,SN123,Produk,,,"'+qty+'"'),/jumlah barang/);
 assert.throws(()=>parse(headers+'\nSPX123,SN1,Produk,,,1\nSPX123,SN2,Produk,,,1'),/berbeda/);
 assert.throws(()=>context.parseCsv('"bad'),/kutip/);
});
test('Excel worksheet rows use same strict grouping as CSV',()=>{
 const r=context.groupShopeeRows([['Tracking Number','Order ID','Product Name','Quantity'],['JNE123','SN123','Toner','2']]);
 assert.equal(r.orders[0].items[0].qty,2);
});
