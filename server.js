require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const https = require('https');
const aws4  = require('aws4');

const R2_BUCKET   = process.env.R2_BUCKET_NAME || 'labqms-pdfs';
const R2_ACCOUNT  = process.env.R2_ACCOUNT_ID  || '';
const R2_HOST     = `${R2_ACCOUNT}.r2.cloudflarestorage.com`;

function r2Request(method, key, body) {
    return new Promise((resolve, reject) => {
        const encodedKey = key.split('/').map(encodeURIComponent).join('/');
        const opts = aws4.sign({
            service:  's3',
            region:   'auto',
            method,
            host:     R2_HOST,
            path:     `/${R2_BUCKET}/${encodedKey}`,
            headers:  body ? { 'Content-Type': 'application/pdf', 'Content-Length': body.length } : {},
            body
        }, {
            accessKeyId:     process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        });

        const req = https.request({
            hostname: R2_HOST,
            path:     `/${R2_BUCKET}/${encodedKey}`,
            method,
            headers:  opts.headers
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                if(res.statusCode >= 300) {
                    reject(new Error(`R2 HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString()}`));
                } else {
                    resolve(Buffer.concat(chunks));
                }
            });
        });
        req.on('error', reject);
        if(body) req.write(body);
        req.end();
    });
}

async function r2Yukle(key, buffer) {
    await r2Request('PUT', key, buffer);
    return key;
}

async function r2Indir(key) {
    return await r2Request('GET', key, null);
}
const puppeteer = require('puppeteer-core');
const QRCode    = require('qrcode');

function chromiumExecPath() {
    if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
    const candidates = [
        '/nix/var/nix/profiles/default/bin/chromium',
        '/run/current-system/sw/bin/chromium',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
    ];
    const found = candidates.find(p => { try { require('fs').accessSync(p); return true; } catch(e) { return false; } });
    if (found) return found;
    try { return require('child_process').execSync('which chromium || which chromium-browser || which google-chrome 2>/dev/null', { timeout: 3000 }).toString().trim(); }
    catch(e) { return 'chromium'; }
}
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');

const app = express(); // İŞTE HATAYA SEBEP OLAN EKSİK SATIR BUYDU!
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));
app.use(express.static(path.join(__dirname, 'public'))); 

// Neon.tech PostgreSQL Bağlantısı
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// TEST YOLU
// Test: ölçüm PDF footer - ?id=SERTIFIKA_ID ile çağır
app.get('/api/test-footer', async (req, res) => {
    let browser;
    try {
        const id = req.params.id || req.query.id;
        if (!id) return res.status(400).send('?id=SERTIFIKA_ID parametresi gerekli');

        const row = await pool.query('SELECT olcum_pdf_url FROM sertifikalar WHERE id=$1', [id]);
        if (!row.rows.length || !row.rows[0].olcum_pdf_url)
            return res.status(404).send('Ölçüm PDF bulunamadı');

        const olcumBytes = Buffer.from(row.rows[0].olcum_pdf_url, 'base64');

        const ayarRows = await pool.query('SELECT anahtar, deger FROM ayarlar');
        const ayar = ayarRows.rows.reduce((o, r) => { o[r.anahtar] = r.deger; return o; }, {});
        const labAdi   = ayar.lab_adi   || 'LAB ADI';
        const labAdres = ayar.adres     || '';
        const labTel   = ayar.telefon   || '';
        const labWeb   = ayar.website   || '';
        const labMail  = ayar.email     || '';

        browser = await puppeteer.launch({
            executablePath: chromiumExecPath(),
            headless: 'new',
            args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote','--single-process'],
        });

        const footerHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8">
        <style>*{margin:0;padding:0;box-sizing:border-box}
        body{width:794px;height:72px;background:white;font-family:Arial,sans-serif;padding:4px 15px 2px}
        .line1{border-top:0.6px solid #aaa;padding-top:3px;display:flex;justify-content:space-between;font-size:7px;color:#555}
        .line2{border-top:0.3px solid #ccc;margin-top:3px;padding-top:2px;font-size:6px;color:#555;line-height:1.45}
        </style></head><body>
        <div class="line1"><span>${labAdi}  ${labAdres}</span><span>${[labTel?'Tel: '+labTel:'',labWeb,labMail].filter(Boolean).join('  |  ')}</span></div>
        <div class="line2">
          Bu sertifika, laboratuvarin yazili izni olmadan kismen kopyalanip cogaltilamaz. | Imzasiz ve TURKAK Dogrulama Kare Kodu bulunmayan sertifikalar gecersizdir.<br>
          Bu sertifikanin kullanimindan once asist.turkak.org.tr uzerinden kare kodu okutarak dogrulayiniz.<br>
          This certificate shall not be reproduced other than in full except with the permission of the laboratory. | Certificates unsigned or without TURKAK QR code are invalid.<br>
          Before using this certificate, verify it by scanning the QR code via asist.turkak.org.tr.
        </div></body></html>`;

        const footerPage = await browser.newPage();
        await footerPage.setViewport({ width: 794, height: 72 });
        await footerPage.setContent(footerHtml, { waitUntil: 'networkidle0' });
        const footerBuffer = await footerPage.pdf({
            width: '794px', height: '72px',
            margin: { top: '0', right: '0', bottom: '0', left: '0' },
            printBackground: true,
        });
        await browser.close(); browser = null;

        const { PDFDocument } = require('pdf-lib');
        const sonDoc = await PDFDocument.create();
        const [embFooter] = await sonDoc.embedPdf(footerBuffer, [0]);
        const embOlcumPages = await sonDoc.embedPdf(olcumBytes);
        const pageW = 595.28, pageH = 841.89;
        const footerH = 72 * (pageH / 1122.52);

        for (const embOlcum of embOlcumPages) {
            const pg = sonDoc.addPage([pageW, pageH]);
            const { width: oW, height: oH } = embOlcum;
            const scale = Math.min(pageW / oW, (pageH - footerH) / oH);
            pg.drawPage(embOlcum, { x: (pageW - oW*scale)/2, y: footerH, width: oW*scale, height: oH*scale });
            pg.drawPage(embFooter, { x: 0, y: 0, width: pageW, height: footerH });
        }

        const pdfBytes = await sonDoc.save();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="test-footer.pdf"');
        res.send(Buffer.from(pdfBytes));
    } catch(err) {
        if(browser) try { await browser.close(); } catch(e) {}
        res.status(500).send('HATA: ' + err.message + '\n' + err.stack);
    }
});

app.get('/api/test', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW()');
        res.json({ success: true, message: "Bağlantı Başarılı!", time: result.rows[0].now });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- MÜŞTERİLER API ---

// 1. LİSTELEME
app.get('/api/musteriler', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM musteriler ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. KAYDET VEYA GÜNCELLE
app.post('/api/musteriler', async (req, res) => {
    try {
        const { id, firma_adi, sube_adi, yetkililer, telefonlar, sertifika_mailleri, fatura_mailleri, il, ilce, adres, vergi_dairesi, vergi_no } = req.body;
        
        if (id) {
            // GÜNCELLEME
            const query = `UPDATE musteriler SET firma_adi=$1, sube_adi=$2, yetkililer=$3, telefonlar=$4, sertifika_mailleri=$5, fatura_mailleri=$6, il=$7, ilce=$8, adres=$9, vergi_dairesi=$10, vergi_no=$11 WHERE id=$12 RETURNING *`;
            const result = await pool.query(query, [firma_adi, sube_adi||null, JSON.stringify(yetkililer), JSON.stringify(telefonlar), JSON.stringify(sertifika_mailleri), JSON.stringify(fatura_mailleri), il, ilce, adres, vergi_dairesi, vergi_no, id]);
            res.json(result.rows[0]);
        } else {
            // YENİ KAYIT
            const query = `INSERT INTO musteriler (firma_adi, sube_adi, yetkililer, telefonlar, sertifika_mailleri, fatura_mailleri, il, ilce, adres, vergi_dairesi, vergi_no) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`;
            const result = await pool.query(query, [firma_adi, sube_adi||null, JSON.stringify(yetkililer), JSON.stringify(telefonlar), JSON.stringify(sertifika_mailleri), JSON.stringify(fatura_mailleri), il, ilce, adres, vergi_dairesi, vergi_no]);
            res.json(result.rows[0]);
        }
    } catch (err) {
        console.error("Hata:", err.message);
        res.status(500).json({ error: "Sunucu Hatası" });
    }
});


// --- KATEGORİ YÖNETİMİ API ---

// 1. Tüm Kategorileri Getir
app.get('/api/kategoriler', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM kategoriler ORDER BY kategori_adi ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Yeni Kategori Ekle
app.post('/api/kategoriler', async (req, res) => {
    try {
        const { kategori_adi } = req.body;
        const result = await pool.query(
            'INSERT INTO kategoriler (kategori_adi) VALUES ($1) RETURNING *',
            [kategori_adi]
        );
        res.json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') { // Benzersizlik hatası
            return res.status(400).json({ error: "Bu kategori zaten mevcut." });
        }
        res.status(500).json({ error: err.message });
    }
});

// 3. Kategori Güncelle
app.put('/api/kategoriler/:id', async (req, res) => {
    try {
        const { kategori_adi } = req.body;
        const result = await pool.query('UPDATE kategoriler SET kategori_adi=$1 WHERE id=$2 RETURNING *', [kategori_adi, req.params.id]);
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Kategori Sil
app.delete('/api/kategoriler/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM kategoriler WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/musteriler/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM musteriler WHERE id=$1', [req.params.id]);
        if(!result.rows.length) return res.status(404).json({ error: 'Bulunamadı' });
        res.json(result.rows[0]);
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/musteriler/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM musteriler WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// CİHAZ KÜTÜPHANESİ API YOLLARI

// 1. Listeleme (Kategorilerle Birlikte)
app.get('/api/cihaz-kutuphanesi', async (req, res) => {
    try {
        const query = `
            SELECT ck.*, k.kategori_adi 
            FROM cihaz_kutuphanesi ck 
            INNER JOIN kategoriler k ON ck.kategori_id = k.id 
            ORDER BY ck.cihaz_adi ASC`;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Kaydetme
app.post('/api/cihaz-kutuphanesi', async (req, res) => {
    try {
        const { kategori_id, cihaz_adi, periyot, fiyat, para_birimi } = req.body;
        const query = `
            INSERT INTO cihaz_kutuphanesi (kategori_id, cihaz_adi, periyot, fiyat, para_birimi) 
            VALUES ($1, $2, $3, $4, $5) RETURNING *`;
        const result = await pool.query(query, [kategori_id, cihaz_adi, periyot, fiyat, para_birimi]);
        res.json(result.rows[0]);
    } catch (err) {
        console.error("Kayıt Hatası:", err.message);
        res.status(500).json({ error: "Veritabanı kayıt hatası." });
    }
});

// 3. Cihaz Güncelle
app.put('/api/cihaz-kutuphanesi/:id', async (req, res) => {
    try {
        const { kategori_id, cihaz_adi, periyot, fiyat, para_birimi } = req.body;
        const result = await pool.query(
            'UPDATE cihaz_kutuphanesi SET kategori_id=$1, cihaz_adi=$2, periyot=$3, fiyat=$4, para_birimi=$5 WHERE id=$6 RETURNING *',
            [kategori_id, cihaz_adi, periyot, fiyat, para_birimi, req.params.id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Cihaz Sil
app.delete('/api/cihaz-kutuphanesi/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM cihaz_kutuphanesi WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// TEKLİF HAZIRLAMA API'LERİ

// 1. Teklif için müşteri ve cihaz bilgilerini getiren endpoint
app.get('/api/teklif-on-veriler', async (req, res) => {
    try {
        const musteriler = await pool.query('SELECT id, firma_adi FROM musteriler ORDER BY firma_adi ASC');
        const cihazlar = await pool.query(`
            SELECT ck.id, ck.cihaz_adi, ck.fiyat, ck.para_birimi, k.kategori_adi 
            FROM cihaz_kutuphanesi ck 
            JOIN kategoriler k ON ck.kategori_id = k.id 
            ORDER BY ck.cihaz_adi ASC`);
        
        res.json({
            musteriler: musteriler.rows,
            cihazlar: cihazlar.rows
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// --- TEKLİFLER ---
app.get('/api/teklifler', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT t.*, m.firma_adi, m.sube_adi, m.adres, m.il, m.ilce, m.yetkililer, m.telefonlar, m.sertifika_mailleri
            FROM teklifler t
            LEFT JOIN musteriler m ON t.musteri_id = m.id
            ORDER BY t.olusturulma_tarihi DESC`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/teklifler/:id', async (req, res) => {
    try {
        const { musteri_id, teklif_tarihi, gecerlilik_gun, teklif_notu, indirim_oran, ara_toplam, genel_toplam, para_birimi, kalemler, durum } = req.body;
        const result = await pool.query(
            `UPDATE teklifler SET musteri_id=$1, teklif_tarihi=$2, gecerlilik_gun=$3, teklif_notu=$4, indirim_oran=$5, ara_toplam=$6, genel_toplam=$7, para_birimi=$8, kalemler=$9, durum=$10 WHERE id=$11 RETURNING *`,
            [musteri_id, teklif_tarihi, gecerlilik_gun, teklif_notu, indirim_oran, ara_toplam, genel_toplam, para_birimi, JSON.stringify(kalemler), durum||'Taslak', req.params.id]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/teklifler/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM teklifler WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Durum güncelle
app.patch('/api/teklifler/:id/durum', async (req, res) => {
    try {
        const { durum } = req.body;
        await pool.query('UPDATE teklifler SET durum=$1 WHERE id=$2', [durum, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Teklif mail gönder
app.post('/api/teklifler/:id/gonder', async (req, res) => {
    try {
        const { mailler } = req.body;
        if (!mailler || !mailler.length) return res.status(400).json({ error: 'En az bir mail adresi gerekli' });

        const teklifResult = await pool.query(
            `SELECT t.*, m.firma_adi, m.sube_adi, m.adres, m.il, m.ilce FROM teklifler t LEFT JOIN musteriler m ON t.musteri_id = m.id WHERE t.id = $1`,
            [req.params.id]
        );
        if (!teklifResult.rows.length) return res.status(404).json({ error: 'Teklif bulunamadı' });
        const t = teklifResult.rows[0];

        const ayarlarResult = await pool.query('SELECT anahtar, deger FROM ayarlar');
        const ay = {};
        ayarlarResult.rows.forEach(r => ay[r.anahtar] = r.deger);
        if (!ay.smtp_host) return res.status(400).json({ error: 'SMTP ayarları yapılandırılmamış. Lütfen Ayarlar sayfasını kontrol edin.' });

        const kalemler = (() => {
            try {
                const kd = typeof t.kalemler === 'object' ? t.kalemler : JSON.parse(t.kalemler || '{}');
                return Array.isArray(kd) ? kd : (kd.items || []);
            } catch(e) { return []; }
        })();
        const kdObj = (() => {
            try {
                const kd = typeof t.kalemler === 'object' ? t.kalemler : JSON.parse(t.kalemler || '{}');
                return Array.isArray(kd) ? { yol_ucreti:0, konaklama_ucreti:0, kdv_oran:20 } : kd;
            } catch(e) { return { yol_ucreti:0, konaklama_ucreti:0, kdv_oran:20 }; }
        })();

        const tarih = t.teklif_tarihi ? new Date(t.teklif_tarihi).toLocaleDateString('tr-TR') : '-';
        const pb = t.para_birimi || '₺';
        const fmt = v => parseFloat(v||0).toLocaleString('tr-TR', {minimumFractionDigits:2});
        const araToplam = parseFloat(t.ara_toplam || 0);
        const indOran = parseFloat(t.indirim_oran || 0);
        const indTutar = araToplam * indOran / 100;
        const yolU = parseFloat(kdObj.yol_ucreti) || 0;
        const konU = parseFloat(kdObj.konaklama_ucreti) || 0;
        const kdvOran = kdObj.kdv_oran != null ? parseFloat(kdObj.kdv_oran) : 20;
        const kdvHaric = (araToplam - indTutar) + yolU + konU;
        const kdvTutar = kdvHaric * kdvOran / 100;
        const kdvDahil = kdvHaric + kdvTutar;
        const labAdi = ay.lab_adi || 'Kalibrasyon Laboratuvarı';
        const adresTam = [t.adres, t.ilce, t.il].filter(Boolean).join(', ') || '';

        const kalemlerHTML = kalemler.map((k,i) => `
            <tr style="background:${i%2===0?'#f8fafc':'#fff'}">
                <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;">${i+1}</td>
                <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;"><strong>${k.ad||''}</strong></td>
                <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${k.ozellik_not||'-'}</td>
                <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${k.hizmet_sekli||'-'}</td>
                <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:center;">${k.adet||1}</td>
                <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:right;">${fmt(k.fiyat)} ${k.pb||pb}</td>
                <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:bold;">${fmt((k.fiyat||0)*(k.adet||1))} ${k.pb||pb}</td>
            </tr>`).join('');

        const htmlBody = `<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8">
<style>body{font-family:Arial,sans-serif;max-width:700px;margin:0 auto;color:#1e293b;font-size:12px;}</style>
</head><body>
<div style="background:#1E40AF;color:white;padding:20px 24px;border-radius:8px 8px 0 0;">
    <div style="font-size:18px;font-weight:bold;">${labAdi}</div>
    <div style="font-size:11px;opacity:0.8;margin-top:4px;">Kalibrasyon ve Test Hizmetleri</div>
</div>
<div style="border:1px solid #e2e8f0;border-top:none;padding:20px 24px;border-radius:0 0 8px 8px;">
    <h2 style="color:#1E40AF;margin:0 0 16px;">TEKLİF / QUOTATION — ${t.teklif_no}</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">
        <div style="background:#f8fafc;padding:12px;border-radius:6px;border:1px solid #e2e8f0;">
            <div style="font-size:10px;color:#64748b;font-weight:bold;text-transform:uppercase;margin-bottom:4px;">Firma Bilgileri</div>
            <div style="font-weight:bold;">${t.firma_adi||''}${t.sube_adi?' / '+t.sube_adi:''}</div>
            ${adresTam ? `<div style="font-size:11px;color:#475569;margin-top:2px;">${adresTam}</div>` : ''}
        </div>
        <div style="background:#f8fafc;padding:12px;border-radius:6px;border:1px solid #e2e8f0;">
            <div style="font-size:10px;color:#64748b;font-weight:bold;text-transform:uppercase;margin-bottom:4px;">Teklif Bilgileri</div>
            <div><strong>No:</strong> ${t.teklif_no}</div>
            <div><strong>Tarih:</strong> ${tarih}</div>
            <div><strong>Geçerlilik:</strong> ${t.gecerlilik_gun||30} Gün</div>
        </div>
    </div>
    ${t.teklif_notu ? `<div style="background:#fffbeb;border:1px solid #fde68a;padding:8px 12px;border-radius:6px;margin-bottom:12px;"><strong>Not:</strong> ${t.teklif_notu}</div>` : ''}
    <table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
        <thead><tr style="background:#1E40AF;color:white;">
            <th style="padding:8px;text-align:left;font-size:11px;">#</th>
            <th style="padding:8px;text-align:left;font-size:11px;">Cihaz / Hizmet</th>
            <th style="padding:8px;text-align:left;font-size:11px;">Özellik</th>
            <th style="padding:8px;text-align:left;font-size:11px;">Hizmet Şekli</th>
            <th style="padding:8px;text-align:center;font-size:11px;">Adet</th>
            <th style="padding:8px;text-align:right;font-size:11px;">Birim</th>
            <th style="padding:8px;text-align:right;font-size:11px;">Toplam</th>
        </tr></thead>
        <tbody>${kalemlerHTML}</tbody>
    </table>
    <div style="margin-left:auto;max-width:320px;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden;">
        ${indOran > 0 ? `<div style="display:flex;justify-content:space-between;padding:6px 12px;border-bottom:1px solid #e2e8f0;"><span style="color:#64748b;">İndirim (%${indOran})</span><span style="color:#dc2626;">− ${fmt(indTutar)} ${pb}</span></div>` : ''}
        ${yolU > 0 ? `<div style="display:flex;justify-content:space-between;padding:6px 12px;border-bottom:1px solid #e2e8f0;"><span>Yol Ücreti</span><span>${fmt(yolU)} ${pb}</span></div>` : ''}
        ${konU > 0 ? `<div style="display:flex;justify-content:space-between;padding:6px 12px;border-bottom:1px solid #e2e8f0;"><span>Konaklama Ücreti</span><span>${fmt(konU)} ${pb}</span></div>` : ''}
        <div style="display:flex;justify-content:space-between;padding:6px 12px;border-bottom:1px solid #e2e8f0;background:#f0f9ff;"><span style="color:#0369a1;font-weight:bold;">KDV Hariç Toplam</span><span style="color:#0369a1;font-weight:bold;">${fmt(kdvHaric)} ${pb}</span></div>
        ${kdvOran > 0 ? `<div style="display:flex;justify-content:space-between;padding:6px 12px;border-bottom:1px solid #e2e8f0;"><span>KDV (%${kdvOran})</span><span>${fmt(kdvTutar)} ${pb}</span></div>` : ''}
        <div style="display:flex;justify-content:space-between;padding:10px 12px;background:#1E40AF;color:white;"><span style="font-weight:bold;">GENEL TOPLAM (KDV DAHİL)</span><span style="font-size:14px;font-weight:800;">${fmt(kdvDahil)} ${pb}</span></div>
    </div>
    <p style="margin-top:20px;font-size:11px;color:#64748b;">Teklifimizin kabulü halinde imzalı, firma kaşeli onayınızı tarafımıza iletmenizi rica ederiz.<br>Bu teklif ${tarih} tarihinde düzenlenmiş olup ${t.gecerlilik_gun||30} gün geçerlidir.</p>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0;">
    <div style="font-size:11px;color:#94a3b8;text-align:center;">${labAdi} | ${ay.telefon||''} | ${ay.email||''}</div>
</div>
</body></html>`;

        const transporter = nodemailer.createTransport({
            host: ay.smtp_host, port: parseInt(ay.smtp_port)||587,
            secure: ay.smtp_secure === 'true',
            auth: { user: ay.smtp_user, pass: ay.smtp_pass },
            connectionTimeout: 10000,
            socketTimeout: 10000,
            tls: { rejectUnauthorized: false }
        });

        await transporter.sendMail({
            from: `"${ay.smtp_from_name || labAdi}" <${ay.smtp_user}>`,
            to: mailler.join(', '),
            subject: `Teklif: ${t.teklif_no} - ${t.firma_adi}`,
            html: htmlBody
        });

        await pool.query("UPDATE teklifler SET durum='Gönderildi' WHERE id=$1", [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/teklifler', async (req, res) => {
    try {
        const { musteri_id, teklif_tarihi, gecerlilik_gun, teklif_notu, indirim_oran, ara_toplam, genel_toplam, para_birimi, kalemler } = req.body;
        // Teklif no oluştur: TKL-2026-001
        const yil = new Date().getFullYear();
        const sayac = await pool.query(`SELECT COUNT(*) FROM teklifler WHERE EXTRACT(YEAR FROM olusturulma_tarihi) = $1`, [yil]);
        const no = String(parseInt(sayac.rows[0].count) + 1).padStart(3, '0');
        const teklif_no = `TKL-${yil}-${no}`;

        const result = await pool.query(
            `INSERT INTO teklifler (musteri_id, teklif_no, teklif_tarihi, gecerlilik_gun, teklif_notu, indirim_oran, ara_toplam, genel_toplam, para_birimi, kalemler)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [musteri_id, teklif_no, teklif_tarihi, gecerlilik_gun, teklif_notu, indirim_oran, ara_toplam, genel_toplam, para_birimi, JSON.stringify(kalemler)]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Teklif PDF üret (Chromium headless)
app.get('/api/teklifler/:id/pdf', async (req, res) => {
    const { exec } = require('child_process');
    const os = require('os');
    const fs = require('fs');
    try {
        const result = await pool.query(
            `SELECT t.*, m.firma_adi, m.sube_adi FROM teklifler t LEFT JOIN musteriler m ON t.musteri_id = m.id WHERE t.id = $1`,
            [req.params.id]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Teklif bulunamadı' });
        const t = result.rows[0];
        const kalemler = Array.isArray(t.kalemler) ? t.kalemler : JSON.parse(t.kalemler || '[]');
        const tarih = t.teklif_tarihi ? new Date(t.teklif_tarihi).toLocaleDateString('tr-TR') : '-';

        const kalemlerHTML = kalemler.map((k, i) => `
            <tr>
                <td>${i + 1}</td>
                <td><strong>${k.ad || ''}</strong></td>
                <td style="font-size:9px;color:#475569;">${k.ozellik_not || '-'}</td>
                <td style="font-size:9px;">${k.hizmet_sekli || '-'}</td>
                <td><span style="padding:2px 5px;border-radius:3px;font-size:9px;font-weight:bold;background:${k.kapsam_durumu === 'Akredite' ? '#dcfce7' : '#fee2e2'};color:${k.kapsam_durumu === 'Akredite' ? '#166534' : '#dc2626'};">${k.kapsam_durumu || '-'}</span></td>
                <td style="text-align:center;">${k.adet || 1}</td>
                <td style="text-align:right;">${parseFloat(k.fiyat || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2 })} ${k.pb || '₺'}</td>
                <td style="text-align:right;font-weight:bold;">${(parseFloat(k.fiyat || 0) * (k.adet || 1)).toLocaleString('tr-TR', { minimumFractionDigits: 2 })} ${k.pb || '₺'}</td>
            </tr>`).join('');

        const html = `<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Arial, sans-serif; padding: 28px 32px; color: #1e293b; font-size: 11px; }
.header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; padding-bottom: 14px; border-bottom: 2px solid #1E40AF; }
.co-name { font-size: 17px; font-weight: bold; color: #1E40AF; }
.co-sub { font-size: 9px; color: #64748b; margin-top: 3px; }
.tno { font-size: 13px; font-weight: bold; color: #1E40AF; }
.info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
.info-box { background: #f8fafc; padding: 10px 12px; border-radius: 6px; border: 1px solid #e2e8f0; }
.lbl { font-size: 8px; font-weight: bold; color: #64748b; text-transform: uppercase; margin-bottom: 2px; }
.val { font-size: 11px; }
table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
thead { background: #1E40AF; color: white; }
th { padding: 7px 6px; text-align: left; font-size: 9px; }
td { padding: 6px 6px; border-bottom: 1px solid #e2e8f0; font-size: 10px; vertical-align: middle; }
tbody tr:nth-child(even) { background: #f8fafc; }
.totals { background: #1E40AF; color: white; padding: 14px 18px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; }
.t-lbl { font-size: 8px; opacity: 0.75; }
.t-val { font-size: 12px; font-weight: bold; }
.t-main { font-size: 15px; font-weight: 800; }
.note-box { background: #fffbeb; border: 1px solid #fde68a; padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; font-size: 10px; }
.footer { margin-top: 24px; font-size: 8.5px; color: #94a3b8; text-align: center; }
</style></head><body>
<div class="header">
    <div>
        <div class="co-name">KALİBRASYON LABORATUVARI</div>
        <div class="co-sub">Kalibrasyon ve Test Hizmetleri</div>
    </div>
    <div style="text-align:right;">
        <div class="tno">${t.teklif_no}</div>
        <div style="font-size:9px;color:#64748b;">TEKLİF BELGESİ</div>
    </div>
</div>
<div class="info-grid">
    <div class="info-box">
        <div class="lbl">Müşteri</div>
        <div class="val" style="font-weight:bold;">${t.firma_adi || ''}${t.sube_adi ? ' / ' + t.sube_adi : ''}</div>
    </div>
    <div class="info-box">
        <div class="lbl">Teklif Tarihi</div><div class="val">${tarih}</div>
        <div class="lbl" style="margin-top:5px;">Geçerlilik Süresi</div><div class="val">${t.gecerlilik_gun || 30} Gün</div>
    </div>
</div>
${t.teklif_notu ? `<div class="note-box"><strong>Not:</strong> ${t.teklif_notu}</div>` : ''}
<table>
    <thead><tr>
        <th style="width:22px;">#</th>
        <th>Cihaz / Hizmet Tanımı</th>
        <th style="width:110px;">Özellik-Not</th>
        <th style="width:115px;">Hizmet Şekli</th>
        <th style="width:72px;">Kapsam</th>
        <th style="width:38px;text-align:center;">Adet</th>
        <th style="width:78px;text-align:right;">Birim Fiyat</th>
        <th style="width:78px;text-align:right;">Toplam</th>
    </tr></thead>
    <tbody>${kalemlerHTML}</tbody>
</table>
<div class="totals">
    <div><div class="t-lbl">Ara Toplam</div><div class="t-val">${parseFloat(t.ara_toplam || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2 })} ${t.para_birimi || '₺'}</div></div>
    ${t.indirim_oran > 0 ? `<div><div class="t-lbl">İndirim (%${t.indirim_oran})</div><div class="t-val">− ${(t.ara_toplam * t.indirim_oran / 100).toLocaleString('tr-TR', { minimumFractionDigits: 2 })} ${t.para_birimi || '₺'}</div></div>` : ''}
    <div style="text-align:right;"><div class="t-lbl">GENEL TOPLAM</div><div class="t-main">${parseFloat(t.genel_toplam || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2 })} ${t.para_birimi || '₺'}</div></div>
</div>
<div class="footer">Bu teklif ${tarih} tarihinde düzenlenmiş olup ${t.gecerlilik_gun || 30} gün geçerlidir.</div>
</body></html>`;

        const tmpId = `${req.params.id}_${Date.now()}`;
        const tmpHtml = path.join(os.tmpdir(), `teklif_${tmpId}.html`);
        const tmpPdf  = path.join(os.tmpdir(), `teklif_${tmpId}.pdf`);
        fs.writeFileSync(tmpHtml, html, 'utf8');

        let chromiumPath = process.env.CHROMIUM_PATH || '';
        if (!chromiumPath) {
            const candidates = [
                '/nix/var/nix/profiles/default/bin/chromium',
                '/run/current-system/sw/bin/chromium',
                '/usr/bin/chromium',
                '/usr/bin/chromium-browser',
                '/usr/bin/google-chrome',
                '/usr/bin/google-chrome-stable',
            ];
            const foundCandidate = candidates.find(p => { try { require('fs').accessSync(p); return true; } catch(e) { return false; } });
            if (foundCandidate) {
                chromiumPath = foundCandidate;
            } else {
                try { chromiumPath = require('child_process').execSync('which chromium || which chromium-browser || which google-chrome-stable || which google-chrome 2>/dev/null', { timeout: 3000 }).toString().trim(); }
                catch(e) { chromiumPath = 'chromium-browser'; }
            }
        }

        await new Promise((resolve, reject) => {
            exec(`"${chromiumPath}" --headless --no-sandbox --disable-gpu --run-all-compositor-stages-before-draw --print-to-pdf="${tmpPdf}" "file://${tmpHtml}"`,
                { timeout: 20000 }, (err) => { if (err) reject(err); else resolve(); });
        });

        const pdfBuffer = fs.readFileSync(tmpPdf);
        try { fs.unlinkSync(tmpHtml); } catch(e) {}
        try { fs.unlinkSync(tmpPdf);  } catch(e) {}

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="teklif_${t.teklif_no}.pdf"`);
        res.send(pdfBuffer);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Firmaya göre müşteri cihazlarını getir (teklif için)
app.get('/api/musteri-cihazlari-firma/:musteri_id', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT mc.id, mc.cihaz_adi, mc.marka, mc.model, mc.seri_no, mc.envanter_no,
                   ck.fiyat, ck.para_birimi
            FROM musteri_cihazlari mc
            LEFT JOIN cihaz_kutuphanesi ck ON LOWER(ck.cihaz_adi) = LOWER(mc.cihaz_adi)
            WHERE mc.musteri_id = $1
            ORDER BY mc.cihaz_adi ASC`,
            [req.params.musteri_id]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- TALİMATLAR (PROSEDÜR) API ---

app.get('/api/talimatlar', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM talimatlar ORDER BY talimat_kodu ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/talimatlar', async (req, res) => {
    try {
        const { talimat_adi, talimat_kodu, olcme_araligi } = req.body;
        const result = await pool.query(
            'INSERT INTO talimatlar (talimat_adi, talimat_kodu, olcme_araligi) VALUES ($1, $2, $3) RETURNING *',
            [talimat_adi, talimat_kodu, olcme_araligi]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/talimatlar/:id', async (req, res) => {
    try {
        const { talimat_adi, talimat_kodu, olcme_araligi } = req.body;
        const result = await pool.query(
            'UPDATE talimatlar SET talimat_adi=$1, talimat_kodu=$2, olcme_araligi=$3 WHERE id=$4 RETURNING *',
            [talimat_adi, talimat_kodu, olcme_araligi, req.params.id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/talimatlar/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM talimatlar WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- REFERANS CİHAZLAR API GRUBU ---

// Tüm cihazları listele (Son işlem bilgisiyle beraber)
app.get('/api/referans-cihazlar', async (req, res) => {
    try {
        const query = `
            SELECT rc.*, k.kategori_adi, rt.sertifika_no, rt.sonraki_kal_tarihi
            FROM referans_cihazlar rc
            LEFT JOIN kategoriler k ON rc.kategori_id = k.id
            LEFT JOIN (
                SELECT DISTINCT ON (referans_id) * FROM referans_takip 
                ORDER BY referans_id, kal_tarihi DESC
            ) rt ON rc.id = rt.referans_id
            ORDER BY rc.id DESC`;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Yeni Referans Cihaz Kaydet (Sabit Veriler)
app.post('/api/referans-cihazlar', async (req, res) => {
    try {
        const { kategori_id, cihaz_adi, marka, model, seri_no, envanter_no, olcme_araligi, kalibrasyon_kriteri, ara_kontrol_kriteri } = req.body;
        const query = `INSERT INTO referans_cihazlar (kategori_id, cihaz_adi, marka, model, seri_no, envanter_no, olcme_araligi, kalibrasyon_kriteri, ara_kontrol_kriteri) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`;
        const result = await pool.query(query, [kategori_id, cihaz_adi, marka, model, seri_no, envanter_no, olcme_araligi, kalibrasyon_kriteri, ara_kontrol_kriteri]);
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// TOPLU EXCEL İMPORT
app.post('/api/referans-cihazlar-toplu', async (req, res) => {
    try {
        const { cihazlar } = req.body; // array
        if (!Array.isArray(cihazlar) || !cihazlar.length) return res.status(400).json({ error: 'Veri yok' });

        // Tüm kategorileri çek (isimle eşleştirme için)
        // NOT: SQL LOWER() yerine JS toLowerCase() kullanıyoruz —
        // PostgreSQL Türkçe locale'de LOWER('I')='ı' ama JS 'I'.toLowerCase()='i' — tutarsızlık!
        const katRes = await pool.query('SELECT id, kategori_adi FROM kategoriler');
        const normalize = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const katMap = {};
        katRes.rows.forEach(k => { katMap[normalize(k.kategori_adi)] = k.id; });

        let basarili = 0, hatali = 0, hatalar = [];
        const kategoriEslesmedi = new Set();

        for (const c of cihazlar) {
            try {
                if (!c.cihaz_adi) { hatali++; hatalar.push(`Satır atlandı: cihaz adı boş`); continue; }
                const katAd = normalize(c.kategori_adi);
                let kategori_id = katAd ? (katMap[katAd] || null) : null;
                if (katAd && !kategori_id) kategoriEslesmedi.add(c.kategori_adi);

                const ins = await pool.query(
                    `INSERT INTO referans_cihazlar (kategori_id, cihaz_adi, marka, model, seri_no, envanter_no, olcme_araligi, kalibrasyon_kriteri, ara_kontrol_kriteri)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
                    [kategori_id, c.cihaz_adi, c.marka||null, c.model||null, c.seri_no||null, c.envanter_no||null, c.olcme_araligi||null, c.kalibrasyon_kriteri||null, c.ara_kontrol_kriteri||null]
                );
                const refId = ins.rows[0].id;

                // Kalibrasyon takip kaydı (sertifika no veya kal tarihi varsa)
                if (c.sertifika_no || c.kal_tarihi) {
                    await pool.query(
                        `INSERT INTO referans_takip (referans_id, islem_tipi, sertifika_no, izlenebilirlik, kal_tarihi, sonraki_kal_tarihi)
                         VALUES ($1,$2,$3,$4,$5,$6)`,
                        [refId, c.islem_tipi||'kalibrasyon', c.sertifika_no||null, c.izlenebilirlik||null, c.kal_tarihi||null, c.sonraki_kal_tarihi||null]
                    );
                }
                basarili++;
            } catch(e) {
                hatali++;
                hatalar.push(`"${c.cihaz_adi}": ${e.message}`);
            }
        }
        res.json({ basarili, hatali, hatalar, kategoriEslesmedi: [...kategoriEslesmedi] });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/referans-cihazlar/:id', async (req, res) => {
    try {
        const { kategori_id, cihaz_adi, marka, model, seri_no, envanter_no, olcme_araligi, kalibrasyon_kriteri, ara_kontrol_kriteri } = req.body;
        const query = `UPDATE referans_cihazlar SET kategori_id=$1, cihaz_adi=$2, marka=$3, model=$4, seri_no=$5, envanter_no=$6, olcme_araligi=$7, kalibrasyon_kriteri=$8, ara_kontrol_kriteri=$9 WHERE id=$10 RETURNING *`;
        const result = await pool.query(query, [kategori_id, cihaz_adi, marka, model, seri_no, envanter_no, olcme_araligi, kalibrasyon_kriteri, ara_kontrol_kriteri, req.params.id]);
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Toplu silme
app.delete('/api/referans-cihazlar-toplu', async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ID listesi boş' });
        const result = await pool.query('DELETE FROM referans_cihazlar WHERE id = ANY($1::int[])', [ids]);
        res.json({ silindi: result.rowCount });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/referans-cihazlar/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM referans_cihazlar WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/referans-takip', async (req, res) => {
    try {
        const { referans_id, islem_tipi, sertifika_no, izlenebilirlik, kal_tarihi, sonraki_kal_tarihi } = req.body;
        const query = `INSERT INTO referans_takip (referans_id, islem_tipi, sertifika_no, izlenebilirlik, kal_tarihi, sonraki_kal_tarihi) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`;
        const result = await pool.query(query, [referans_id, islem_tipi, sertifika_no, izlenebilirlik, kal_tarihi, sonraki_kal_tarihi]);
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/referans-takip-guncelle', async (req, res) => {
    try {
        const { id, sertifika_no, izlenebilirlik, kal_tarihi, sonraki_kal_tarihi } = req.body;
        const query = `
            UPDATE referans_takip 
            SET sertifika_no = $2, izlenebilirlik = $3, kal_tarihi = $4, sonraki_kal_tarihi = $5 
            WHERE id = $1 RETURNING *`;
        const result = await pool.query(query, [id, sertifika_no, izlenebilirlik, kal_tarihi, sonraki_kal_tarihi]);
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Cihazın Tüm Tarihçesini Getir (Tıklayınca açılan kısım için KRİTİK)
app.get('/api/referans-tarihce/:id', async (req, res) => {
    try {
        const { id } = req.params;
        // Sorguya rt.id'yi ekledik
        const query = `SELECT id, islem_tipi, sertifika_no, izlenebilirlik, kal_tarihi, sonraki_kal_tarihi 
                       FROM referans_takip 
                       WHERE referans_id = $1 
                       ORDER BY kal_tarihi DESC`;
        const result = await pool.query(query, [id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/metot-yardimci-veriler', async (req, res) => {
    try {
        // Tablo adını 'talimatlar' olarak güncelledik
        const talimatlar = await pool.query('SELECT id, talimat_adi, talimat_kodu FROM talimatlar');
        
        // Referanslar (En güncel SKT ile)
        const referanslar = await pool.query(`
            SELECT rc.id, rc.cihaz_adi, rc.seri_no, rt.sonraki_kal_tarihi
            FROM referans_cihazlar rc
            LEFT JOIN (
                SELECT DISTINCT ON (referans_id) referans_id, sonraki_kal_tarihi 
                FROM referans_takip 
                ORDER BY referans_id, kal_tarihi DESC
            ) rt ON rc.id = rt.referans_id
        `);

        res.json({
            talimatlar: talimatlar.rows,
            referanslar: referanslar.rows
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// --- KALİBRASYON METOTLARI API ---

// LİSTELE
app.get('/api/metotlar', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT km.*, 
                COALESCE(
                    (SELECT json_agg(json_build_object('id', t.id, 'talimat_kodu', t.talimat_kodu, 'talimat_adi', t.talimat_adi))
                     FROM talimatlar t WHERE t.id = ANY(km.talimatlar)), '[]'
                ) as talimat_detay,
                COALESCE(
                    (SELECT json_agg(json_build_object('id', rc.id, 'cihaz_adi', rc.cihaz_adi, 'seri_no', rc.seri_no))
                     FROM referans_cihazlar rc WHERE rc.id = ANY(km.referanslar)), '[]'
                ) as referans_detay
            FROM kalibrasyon_metotlari km
            ORDER BY km.id DESC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// KAYDET
app.post('/api/metotlar', async (req, res) => {
    try {
        const { metot_adi, metot_kodu, talimatlar, referanslar } = req.body;
        const result = await pool.query(
            `INSERT INTO kalibrasyon_metotlari (metot_adi, metot_kodu, talimatlar, referanslar)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [metot_adi, metot_kodu, talimatlar.map(Number), referanslar.map(Number)]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GÜNCELLE
app.put('/api/metotlar/:id', async (req, res) => {
    try {
        const { metot_adi, metot_kodu, talimatlar, referanslar } = req.body;
        const result = await pool.query(
            `UPDATE kalibrasyon_metotlari SET metot_adi=$1, metot_kodu=$2, talimatlar=$3, referanslar=$4 WHERE id=$5 RETURNING *`,
            [metot_adi, metot_kodu, talimatlar.map(Number), referanslar.map(Number), req.params.id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// SİL
app.delete('/api/metotlar/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM kalibrasyon_metotlari WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// --- MÜŞTERİ CİHAZLARI API ---

app.get('/api/musteri-cihazlari-on-veriler', async (req, res) => {
    try {
        const musteriler = await pool.query('SELECT id, firma_adi FROM musteriler ORDER BY firma_adi ASC');
        const kategoriler = await pool.query('SELECT id, kategori_adi FROM kategoriler ORDER BY kategori_adi ASC');
        const cihazlar = await pool.query('SELECT id, cihaz_adi FROM cihaz_kutuphanesi ORDER BY cihaz_adi ASC');
        const metotlar = await pool.query('SELECT id, metot_adi, metot_kodu FROM kalibrasyon_metotlari ORDER BY metot_kodu ASC');
        res.json({ musteriler: musteriler.rows, kategoriler: kategoriler.rows, cihazlar: cihazlar.rows, metotlar: metotlar.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/musteri-cihazlari/:id', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT mc.*, 
                m.firma_adi,
                k.kategori_adi,
                km.metot_kodu,
                km.metot_adi,
                COALESCE(
                    (SELECT json_agg(json_build_object('talimat_kodu', t.talimat_kodu, 'talimat_adi', t.talimat_adi))
                     FROM talimatlar t WHERE t.id = ANY(km.talimatlar)), '[]'
                ) as talimat_detay,
                COALESCE(
                    (SELECT json_agg(json_build_object('cihaz_adi', rc.cihaz_adi, 'marka', rc.marka, 'model', rc.model, 'seri_no', rc.seri_no, 'envanter_no', rc.envanter_no))
                     FROM referans_cihazlar rc WHERE rc.id = ANY(km.referanslar)), '[]'
                ) as referans_detay
            FROM musteri_cihazlari mc
            LEFT JOIN musteriler m ON mc.musteri_id = m.id
            LEFT JOIN kategoriler k ON mc.kategori_id = k.id
            LEFT JOIN kalibrasyon_metotlari km ON mc.metot_id = km.id
            WHERE mc.id = $1
        `, [req.params.id]);
        if(!result.rows.length) return res.status(404).json({ error: 'Bulunamadı' });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/musteri-cihazlari', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT mc.*, 
                m.firma_adi, 
                k.kategori_adi,
                km.metot_kodu, km.metot_adi as metot_adi_full
            FROM musteri_cihazlari mc
            LEFT JOIN musteriler m ON mc.musteri_id = m.id
            LEFT JOIN kategoriler k ON mc.kategori_id = k.id
            LEFT JOIN kalibrasyon_metotlari km ON mc.metot_id = km.id
            ORDER BY mc.id DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/musteri-cihazlari', async (req, res) => {
    try {
        const { musteri_id, kategori_id, cihaz_adi, marka, model, seri_no, envanter_no, olcum_araligi, cozunurluk, metot_id, degerlendirme_kriteri, kalibrasyon_yeri } = req.body;
        // Mükerrer kayıt kontrolü
        if (seri_no) {
            const dup = await pool.query(
                'SELECT id FROM musteri_cihazlari WHERE musteri_id=$1 AND cihaz_adi=$2 AND seri_no=$3',
                [musteri_id, cihaz_adi, seri_no]
            );
            if (dup.rows.length > 0)
                return res.status(409).json({ error: `Bu firmaya ait "${cihaz_adi}" cihazından aynı seri numarasıyla (${seri_no}) kayıt zaten mevcut!` });
        } else if (envanter_no) {
            const dup = await pool.query(
                'SELECT id FROM musteri_cihazlari WHERE musteri_id=$1 AND cihaz_adi=$2 AND envanter_no=$3',
                [musteri_id, cihaz_adi, envanter_no]
            );
            if (dup.rows.length > 0)
                return res.status(409).json({ error: `Bu firmaya ait "${cihaz_adi}" cihazından aynı envanter numarasıyla (${envanter_no}) kayıt zaten mevcut!` });
        }
        const result = await pool.query(
            `INSERT INTO musteri_cihazlari (musteri_id, kategori_id, cihaz_adi, marka, model, seri_no, envanter_no, olcum_araligi, cozunurluk, metot_id, degerlendirme_kriteri, kalibrasyon_yeri)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [musteri_id, kategori_id||null, cihaz_adi, marka, model, seri_no||null, envanter_no||null, olcum_araligi, cozunurluk, metot_id||null, degerlendirme_kriteri, kalibrasyon_yeri]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/musteri-cihazlari/:id', async (req, res) => {
    try {
        const { musteri_id, kategori_id, cihaz_adi, marka, model, seri_no, envanter_no, olcum_araligi, cozunurluk, metot_id, degerlendirme_kriteri, kalibrasyon_yeri } = req.body;
        const result = await pool.query(
            `UPDATE musteri_cihazlari SET musteri_id=$1, kategori_id=$2, cihaz_adi=$3, marka=$4, model=$5, seri_no=$6, envanter_no=$7, olcum_araligi=$8, cozunurluk=$9, metot_id=$10, degerlendirme_kriteri=$11, kalibrasyon_yeri=$12 WHERE id=$13 RETURNING *`,
            [musteri_id, kategori_id||null, cihaz_adi, marka, model, seri_no||null, envanter_no||null, olcum_araligi, cozunurluk, metot_id||null, degerlendirme_kriteri, kalibrasyon_yeri, req.params.id]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/musteri-cihazlari/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM musteri_cihazlari WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- AYARLAR ---
app.get('/api/ayarlar', async (req, res) => {
    try {
        const result = await pool.query('SELECT anahtar, deger FROM ayarlar');
        const ayarlar = {};
        result.rows.forEach(r => ayarlar[r.anahtar] = r.deger);
        res.json(ayarlar);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ayarlar', async (req, res) => {
    try {
        const ayarlar = req.body;
        for (const [anahtar, deger] of Object.entries(ayarlar)) {
            await pool.query(
                `INSERT INTO ayarlar (anahtar, deger) VALUES ($1, $2)
                 ON CONFLICT (anahtar) DO UPDATE SET deger = $2`,
                [anahtar, deger]
            );
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- İŞ EMİRLERİ ---
app.get('/api/is-emirleri-on-veriler', async (req, res) => {
    try {
        const [musteriler, personeller, teklifler] = await Promise.all([
            pool.query('SELECT id, firma_adi, sube_adi FROM musteriler ORDER BY firma_adi'),
            pool.query('SELECT id, ad_soyad, varsayilan_onaylayici FROM personeller ORDER BY ad_soyad'),
            pool.query('SELECT id, teklif_no, musteri_id FROM teklifler ORDER BY id DESC')
        ]);
        res.json({ musteriler: musteriler.rows, personeller: personeller.rows, teklifler: teklifler.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/is-emirleri', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT ie.*, m.firma_adi, m.sube_adi,
                   t.teklif_no,
                   p.ad_soyad as teslim_alan_adi
            FROM is_emirleri ie
            LEFT JOIN musteriler m ON ie.musteri_id = m.id
            LEFT JOIN teklifler t ON ie.teklif_id = t.id
            LEFT JOIN personeller p ON ie.teslim_alan_id = p.id
            ORDER BY ie.olusturulma DESC`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/is-emirleri', async (req, res) => {
    try {
        const { musteri_id, kabul_tarihi, teslim_tarihi, cihazlar, notlar,
                teklif_id, teslim_eden, teslim_alan_id } = req.body;
        const yil = new Date().getFullYear();
        const sayacRes = await pool.query(
            `SELECT COUNT(*) FROM is_emirleri WHERE ie_no LIKE $1`, [`IE-${yil}-%`]);
        const sira = parseInt(sayacRes.rows[0].count) + 1;
        const ie_no = `IE-${yil}-${String(sira).padStart(3,'0')}`;
        const result = await pool.query(
            `INSERT INTO is_emirleri (ie_no, musteri_id, kabul_tarihi, teslim_tarihi, cihazlar, notlar, asama,
             teklif_id, teslim_eden, teslim_alan_id)
             VALUES ($1,$2,$3,$4,$5,$6,'kabul_edildi',$7,$8,$9) RETURNING *`,
            [ie_no, musteri_id, kabul_tarihi, teslim_tarihi||null, JSON.stringify(cihazlar), notlar||'',
             teklif_id||null, teslim_eden||null, teslim_alan_id||null]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/is-emirleri/:id/asama', async (req, res) => {
    try {
        const { asama } = req.body;
        const result = await pool.query(
            `UPDATE is_emirleri SET asama=$1 WHERE id=$2 RETURNING *`,
            [asama, req.params.id]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/is-emirleri/:id', async (req, res) => {
    try {
        const { musteri_id, kabul_tarihi, teslim_tarihi, cihazlar, notlar, asama,
                teklif_id, teslim_eden, teslim_alan_id } = req.body;
        const result = await pool.query(
            `UPDATE is_emirleri SET musteri_id=$1, kabul_tarihi=$2, teslim_tarihi=$3, cihazlar=$4,
             notlar=$5, asama=$6, teklif_id=$7, teslim_eden=$8, teslim_alan_id=$9 WHERE id=$10 RETURNING *`,
            [musteri_id, kabul_tarihi, teslim_tarihi||null, JSON.stringify(cihazlar), notlar||'',
             asama, teklif_id||null, teslim_eden||null, teslim_alan_id||null, req.params.id]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/is-emirleri/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM is_emirleri WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- DASHBOARD İSTATİSTİKLERİ ---
app.get('/api/dashboard', async (req, res) => {
    try {
        const [kabulEdilenler, hazırlananlar, tamamlananlar, buYil, musteriler, referanslar, takvimleri, revizyonlar] = await Promise.all([
            pool.query(`SELECT COUNT(*) FROM is_emirleri WHERE asama='kabul_edildi'`),
            pool.query(`SELECT COUNT(*) FROM is_emirleri WHERE asama IN ('hazırlanıyor','tamamlandı','imzalandı')`),
            pool.query(`SELECT COUNT(*) FROM is_emirleri WHERE asama='onaylandı' OR asama='sertifika_gönderildi'`),
            pool.query(`SELECT COUNT(*) FROM is_emirleri WHERE EXTRACT(YEAR FROM olusturulma)=EXTRACT(YEAR FROM NOW()) AND asama='sertifika_gönderildi'`),
            pool.query(`SELECT COUNT(*) FROM musteriler`),
            // Referans cihazlar: KALİBRASYON için 30 gün, ARA_KONTROL için 30 gün eşiği
            pool.query(`
                SELECT rc.cihaz_adi, rc.seri_no, rt.sonraki_kal_tarihi, rt.islem_tipi,
                    (rt.sonraki_kal_tarihi - CURRENT_DATE) as kalan_gun
                FROM referans_cihazlar rc
                JOIN (
                    SELECT DISTINCT ON (referans_id) referans_id, sonraki_kal_tarihi, islem_tipi
                    FROM referans_takip ORDER BY referans_id, kal_tarihi DESC
                ) rt ON rc.id = rt.referans_id
                WHERE rt.sonraki_kal_tarihi <= CURRENT_DATE + INTERVAL '30 days'
                ORDER BY rt.sonraki_kal_tarihi ASC
                LIMIT 15`),
            // Takvim: yarın başlayacak etkinlikler (1 gün kala bildirimi)
            pool.query(`
                SELECT t.*, p.ad_soyad as atanan_adi
                FROM takvim t
                LEFT JOIN personeller p ON t.atanan_id = p.id
                WHERE t.baslangic = CURRENT_DATE + INTERVAL '1 day'
                ORDER BY t.baslangic ASC`),
            // Son 30 günde revize edilen dokümanlar
            pool.query(`
                SELECT p.baslik, p.dok_no, p.revizyon_no, p.gecerlilik_tarihi as revizyon_tarihi
                FROM kalite_dokuman p
                WHERE p.parent_id IS NULL
                AND p.gecerlilik_tarihi >= CURRENT_DATE - INTERVAL '7 days'
                AND EXISTS (SELECT 1 FROM kalite_dokuman c WHERE c.parent_id = p.id)
                ORDER BY p.gecerlilik_tarihi DESC
                LIMIT 10`)
        ]);
        res.json({
            kabul_edildi: parseInt(kabulEdilenler.rows[0].count),
            kalibrasyonda: parseInt(hazırlananlar.rows[0].count),
            onay_bekleyen: parseInt(tamamlananlar.rows[0].count),
            bu_yil: parseInt(buYil.rows[0].count),
            musteri_sayisi: parseInt(musteriler.rows[0].count),
            yaklasan_aktiviteler: referanslar.rows,
            yaklasan_etkinlikler: takvimleri.rows,
            son_revizyonlar: revizyonlar.rows
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- TAKVİM ---
app.get('/api/takvim', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT t.*, p.ad_soyad as atanan_adi
            FROM takvim t
            LEFT JOIN personeller p ON t.atanan_id = p.id
            ORDER BY t.baslangic ASC`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/takvim', async (req, res) => {
    try {
        const { baslik, aciklama, baslangic, bitis, atanan_id, renk, tip } = req.body;
        const result = await pool.query(
            `INSERT INTO takvim (baslik, aciklama, baslangic, bitis, atanan_id, renk, tip, olusturan_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [baslik, aciklama||'', baslangic, bitis||baslangic, atanan_id||null, renk||'#1E40AF', tip||'genel', null]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/takvim/:id', async (req, res) => {
    try {
        const { baslik, aciklama, baslangic, bitis, atanan_id, renk, tip } = req.body;
        const result = await pool.query(
            `UPDATE takvim SET baslik=$1, aciklama=$2, baslangic=$3, bitis=$4, atanan_id=$5, renk=$6, tip=$7 WHERE id=$8 RETURNING *`,
            [baslik, aciklama||'', baslangic, bitis||baslangic, atanan_id||null, renk||'#1E40AF', tip||'genel', req.params.id]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/takvim/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM takvim WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- PERSONEL YÖNETİMİ ---
app.get('/api/personeller', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM personeller ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/personeller', async (req, res) => {
    try {
        const { ad_soyad, kullanici_adi, sifre, roller, erisimler, varsayilan_onaylayici } = req.body;
        if (varsayilan_onaylayici) {
            await pool.query('UPDATE personeller SET varsayilan_onaylayici = false');
        }
        const result = await pool.query(
            `INSERT INTO personeller (ad_soyad, kullanici_adi, sifre, roller, erisimler, varsayilan_onaylayici)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [ad_soyad, kullanici_adi, sifre, JSON.stringify(roller), JSON.stringify(erisimler), varsayilan_onaylayici]
        );
        res.json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: "Bu kullanıcı adı zaten kullanılıyor!" });
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/personeller/:id', async (req, res) => {
    try {
        const { ad_soyad, kullanici_adi, sifre, roller, erisimler, varsayilan_onaylayici } = req.body;
        if (varsayilan_onaylayici) {
            await pool.query('UPDATE personeller SET varsayilan_onaylayici = false');
        }
        const result = await pool.query(
            `UPDATE personeller SET ad_soyad=$1, kullanici_adi=$2, sifre=$3, roller=$4, erisimler=$5, varsayilan_onaylayici=$6 WHERE id=$7 RETURNING *`,
            [ad_soyad, kullanici_adi, sifre, JSON.stringify(roller), JSON.stringify(erisimler), varsayilan_onaylayici, req.params.id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: "Bu kullanıcı adı zaten kullanılıyor!" });
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/personeller/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM personeller WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- GİRİŞ (LOGIN) ---
app.post('/api/login', async (req, res) => {
    try {
        const { kullanici_adi, sifre } = req.body;
        const result = await pool.query(
            'SELECT id, ad_soyad, kullanici_adi, roller, erisimler FROM personeller WHERE kullanici_adi=$1 AND sifre=$2',
            [kullanici_adi, sifre]
        );
        if (result.rows.length > 0) {
            res.json({ success: true, user: result.rows[0] });
        } else {
            res.status(401).json({ success: false, error: "Kullanıcı adı veya şifre hatalı!" });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── KALİTE SİSTEMİ TABLOLARI ───────────────────────────────────────────────
async function createKaliteTables() {
    const sqls = [
        `CREATE TABLE IF NOT EXISTS kalite_dokuman (
            id SERIAL PRIMARY KEY,
            dok_no VARCHAR(50),
            baslik VARCHAR(255) NOT NULL,
            tur VARCHAR(50),
            revizyon_no VARCHAR(20),
            yayin_tarihi DATE,
            gecerlilik_tarihi DATE,
            durum VARCHAR(30) DEFAULT 'taslak',
            sorumlu VARCHAR(100),
            aciklama TEXT,
            olusturma_tarihi TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS uygunsuzluk (
            id SERIAL PRIMARY KEY,
            kayit_no VARCHAR(50),
            tarih DATE,
            kaynak VARCHAR(50),
            aciklama TEXT,
            tespit_eden VARCHAR(100),
            durum VARCHAR(30) DEFAULT 'acik',
            kapatis_tarihi DATE,
            olusturma_tarihi TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS dof (
            id SERIAL PRIMARY KEY,
            uygunsuzluk_id INTEGER REFERENCES uygunsuzluk(id) ON DELETE CASCADE,
            kok_neden TEXT,
            faaliyet_tanimi TEXT,
            sorumlu VARCHAR(100),
            termin DATE,
            tamamlandi_tarihi DATE,
            sonuc TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS ic_denetim (
            id SERIAL PRIMARY KEY,
            denetim_no VARCHAR(50),
            plan_tarihi DATE,
            tamamlandi_tarihi DATE,
            kapsam TEXT,
            denetci VARCHAR(150),
            durum VARCHAR(30) DEFAULT 'planlandı',
            aciklama TEXT,
            olusturma_tarihi TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS ic_denetim_bulgu (
            id SERIAL PRIMARY KEY,
            denetim_id INTEGER REFERENCES ic_denetim(id) ON DELETE CASCADE,
            bulgu_turu VARCHAR(30),
            madde_no VARCHAR(50),
            aciklama TEXT,
            durum VARCHAR(20) DEFAULT 'acik',
            kapanis_tarihi DATE
        )`,
        `CREATE TABLE IF NOT EXISTS risk_kaydi (
            id SERIAL PRIMARY KEY,
            risk_no VARCHAR(50),
            tarih DATE,
            tur VARCHAR(20) DEFAULT 'risk',
            kategori VARCHAR(50),
            tanim TEXT,
            etki SMALLINT,
            olasilik SMALLINT,
            risk_skoru SMALLINT,
            onlem TEXT,
            sorumlu VARCHAR(100),
            termin DATE,
            durum VARCHAR(30) DEFAULT 'acik',
            olusturma_tarihi TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS musteri_sikayet (
            id SERIAL PRIMARY KEY,
            sikayet_no VARCHAR(50),
            tarih DATE,
            musteri_id INTEGER,
            musteri_adi VARCHAR(200),
            aciklama TEXT,
            oncelik VARCHAR(20) DEFAULT 'orta',
            durum VARCHAR(30) DEFAULT 'acik',
            kapatis_tarihi DATE,
            sonuc TEXT,
            olusturma_tarihi TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS dis_tedarikci (
            id SERIAL PRIMARY KEY,
            firma_adi VARCHAR(200) NOT NULL,
            hizmet_turu VARCHAR(100),
            iletisim VARCHAR(200),
            onay_durumu VARCHAR(30) DEFAULT 'beklemede',
            aciklama TEXT,
            olusturma_tarihi TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS dis_tedarikci_degerlendirme (
            id SERIAL PRIMARY KEY,
            tedarikci_id INTEGER REFERENCES dis_tedarikci(id) ON DELETE CASCADE,
            tarih DATE,
            puan SMALLINT,
            degerlendiren VARCHAR(100),
            notlar TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS yeterlilik_testi (
            id SERIAL PRIMARY KEY,
            program_adi VARCHAR(200),
            organizator VARCHAR(200),
            katilim_tarihi DATE,
            parametreler TEXT,
            sonuc VARCHAR(30) DEFAULT 'beklemede',
            z_skoru VARCHAR(50),
            aciklama TEXT,
            olusturma_tarihi TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS ygg_toplanti (
            id SERIAL PRIMARY KEY,
            toplanti_no VARCHAR(50),
            tarih DATE,
            katilimcilar TEXT,
            gundem TEXT,
            kararlar TEXT,
            durum VARCHAR(30) DEFAULT 'planlandı',
            bir_sonraki_tarih DATE,
            olusturma_tarihi TIMESTAMP DEFAULT NOW()
        )`
    ];
    for (const sql of sqls) { await pool.query(sql); }
    console.log('✅ Kalite sistemi tabloları hazır.');
}

// ── GROQ AI ASISTAN ──
app.post('/api/ai/sor', async (req, res) => {
    const { mesaj, gecmis = [] } = req.body;
    if (!mesaj) return res.status(400).json({ hata: 'Mesaj boş olamaz.' });
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(500).json({ hata: 'GROQ_API_KEY tanımlı değil.' });

    const sistem = `Sen LabQMS Pro adlı laboratuvar kalite yönetim sisteminin yapay zeka asistanısın.
Kullanıcılar laboratuvar kalite yönetimi, ISO 17025, kalibrasyon, uygunsuzluk, DÖF (Düzeltici ve Önleyici Faaliyet),
doküman yönetimi, sertifika süreçleri gibi konularda sana soru sorabilir.
Kısa, net ve pratik cevaplar ver. Türkçe konuş.`;

    const mesajlar = [
        { role: 'system', content: sistem },
        ...gecmis.slice(-6),
        { role: 'user', content: mesaj }
    ];

    const body = JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: mesajlar,
        max_tokens: 1024,
        temperature: 0.7
    });

    const options = {
        hostname: 'api.groq.com',
        path: '/openai/v1/chat/completions',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(body)
        }
    };

    const apiReq = https.request(options, (apiRes) => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', () => {
            try {
                const parsed = JSON.parse(data);
                const cevap = parsed.choices?.[0]?.message?.content;
                if (cevap) res.json({ cevap });
                else res.status(500).json({ hata: 'Yanıt alınamadı.', detay: data });
            } catch(e) { res.status(500).json({ hata: 'Parse hatası.' }); }
        });
    });
    apiReq.on('error', e => res.status(500).json({ hata: e.message }));
    apiReq.write(body);
    apiReq.end();
});

app.listen(PORT, async () => {
    console.log(`🚀 Sunucu ${PORT} portunda başarıyla ayağa kalktı.`);
    await createKaliteTables().catch(e => console.error('Tablo oluşturma hatası:', e.message));
    // Türkçe karakter normalizasyonu: "yayında" → "yayinda", "i̇ptal" → "iptal"
    await pool.query(`UPDATE kalite_dokuman SET durum='yayinda' WHERE durum='yayında'`).catch(()=>{});
    await pool.query(`UPDATE kalite_dokuman SET durum='iptal' WHERE durum='i̇ptal'`).catch(()=>{});
    // Revizyon yapısı için parent_id kolonu ekle
    await pool.query(`ALTER TABLE kalite_dokuman ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES kalite_dokuman(id) ON DELETE CASCADE`).catch(()=>{});
    // Uygunsuzluk yeni alanlar
    await pool.query(`ALTER TABLE uygunsuzluk ADD COLUMN IF NOT EXISTS esas_alinan_sart TEXT`).catch(()=>{});
    await pool.query(`ALTER TABLE uygunsuzluk ADD COLUMN IF NOT EXISTS sinif VARCHAR(20)`).catch(()=>{});
    await pool.query(`ALTER TABLE dof ADD COLUMN IF NOT EXISTS kapsam_etki TEXT`).catch(()=>{});
    await pool.query(`ALTER TABLE dof ADD COLUMN IF NOT EXISTS yayilma_etki TEXT`).catch(()=>{});
});

// ─── KALİTE SİSTEMİ API ROTALARI ────────────────────────────────────────────

// --- DOKÜMAN YÖNETİMİ ---
app.get('/api/kalite-dokuman', async (req, res) => {
    try {
        const r = await pool.query(`
            SELECT d.*,
                (SELECT COUNT(*) FROM kalite_dokuman r WHERE r.parent_id = d.id) AS revizyon_sayisi
            FROM kalite_dokuman d
            WHERE d.parent_id IS NULL
            ORDER BY d.olusturma_tarihi DESC`);
        res.json(r.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/kalite-dokuman/:id/revizyonlar', async (req, res) => {
    try {
        const r = await pool.query(
            'SELECT * FROM kalite_dokuman WHERE parent_id=$1 ORDER BY olusturma_tarihi ASC',
            [req.params.id]
        );
        res.json(r.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/kalite-dokuman/:id/revize', async (req, res) => {
    try {
        const parent = await pool.query('SELECT * FROM kalite_dokuman WHERE id=$1', [req.params.id]);
        if (!parent.rows.length) return res.status(404).json({ error: 'Doküman bulunamadı' });
        const p = parent.rows[0];
        const { revizyon_no, yayin_tarihi } = req.body;
        // Eski veriyi alt kayıt olarak iptal durumunda kaydet
        await pool.query(
            `INSERT INTO kalite_dokuman (dok_no,baslik,tur,revizyon_no,yayin_tarihi,gecerlilik_tarihi,durum,aciklama,parent_id)
             VALUES ($1,$2,$3,$4,$5,$6,'iptal',$7,$8)`,
            [p.dok_no, p.baslik, p.tur, p.revizyon_no, p.yayin_tarihi||null, p.gecerlilik_tarihi||null, p.aciklama, p.id]
        );
        // Ana kaydı yeni revizyon no ve revizyon tarihiyle güncelle
        const r = await pool.query(
            `UPDATE kalite_dokuman SET revizyon_no=$1, gecerlilik_tarihi=$2 WHERE id=$3 RETURNING *`,
            [revizyon_no, yayin_tarihi||null, p.id]
        );
        res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/kalite-dokuman', async (req, res) => {
    try {
        const { dok_no, baslik, tur, revizyon_no, yayin_tarihi, gecerlilik_tarihi, durum, aciklama } = req.body;
        const r = await pool.query(
            `INSERT INTO kalite_dokuman (dok_no,baslik,tur,revizyon_no,yayin_tarihi,gecerlilik_tarihi,durum,aciklama)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [dok_no, baslik, tur, revizyon_no, yayin_tarihi||null, gecerlilik_tarihi||null, durum||'taslak', aciklama]
        );
        res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/kalite-dokuman/:id', async (req, res) => {
    try {
        const { dok_no, baslik, tur, revizyon_no, yayin_tarihi, gecerlilik_tarihi, durum, aciklama } = req.body;
        const r = await pool.query(
            `UPDATE kalite_dokuman SET dok_no=$1,baslik=$2,tur=$3,revizyon_no=$4,yayin_tarihi=$5,gecerlilik_tarihi=$6,durum=$7,aciklama=$8 WHERE id=$9 RETURNING *`,
            [dok_no, baslik, tur, revizyon_no, yayin_tarihi||null, gecerlilik_tarihi||null, durum, aciklama, req.params.id]
        );
        res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/kalite-dokuman-toplu', async (req, res) => {
    try {
        const { kayitlar } = req.body;
        let basarili = 0, hatali = 0, hatalar = [];
        for (const k of kayitlar) {
            try {
                if (!k.baslik) { hatalar.push(`Başlık boş: ${JSON.stringify(k)}`); hatali++; continue; }
                await pool.query(
                    `INSERT INTO kalite_dokuman (dok_no,baslik,tur,revizyon_no,yayin_tarihi,gecerlilik_tarihi,durum,aciklama)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                    [k.dok_no||null, k.baslik, k.tur||null, k.revizyon_no||null, k.yayin_tarihi||null, k.gecerlilik_tarihi||null, k.durum||'taslak', k.aciklama||null]
                );
                basarili++;
            } catch(e) { hatalar.push(k.baslik + ': ' + e.message); hatali++; }
        }
        res.json({ basarili, hatali, hatalar });
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/kalite-dokuman-toplu-sil', async (req, res) => {
    try {
        const { ids } = req.body;
        await pool.query('DELETE FROM kalite_dokuman WHERE id=ANY($1)', [ids]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/kalite-dokuman/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM kalite_dokuman WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- UYGUNSUZLUK ---
app.get('/api/uygunsuzluk', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM uygunsuzluk ORDER BY olusturma_tarihi DESC');
        res.json(r.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/uygunsuzluk', async (req, res) => {
    try {
        const { kayit_no, tarih, kaynak, aciklama, tespit_eden, durum, kapatis_tarihi, esas_alinan_sart, sinif } = req.body;
        const r = await pool.query(
            `INSERT INTO uygunsuzluk (kayit_no,tarih,kaynak,aciklama,tespit_eden,durum,kapatis_tarihi,esas_alinan_sart,sinif)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [kayit_no, tarih||null, kaynak, aciklama, tespit_eden, durum||'acik', kapatis_tarihi||null, esas_alinan_sart||null, sinif||null]
        );
        res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/uygunsuzluk/:id', async (req, res) => {
    try {
        const { kayit_no, tarih, kaynak, aciklama, tespit_eden, durum, kapatis_tarihi, esas_alinan_sart, sinif } = req.body;
        const r = await pool.query(
            `UPDATE uygunsuzluk SET kayit_no=$1,tarih=$2,kaynak=$3,aciklama=$4,tespit_eden=$5,durum=$6,kapatis_tarihi=$7,esas_alinan_sart=$8,sinif=$9 WHERE id=$10 RETURNING *`,
            [kayit_no, tarih||null, kaynak, aciklama, tespit_eden, durum, kapatis_tarihi||null, esas_alinan_sart||null, sinif||null, req.params.id]
        );
        res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/uygunsuzluk/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM uygunsuzluk WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- DÖF ---
app.get('/api/dof/:uygunsuzluk_id', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM dof WHERE uygunsuzluk_id=$1 ORDER BY id', [req.params.uygunsuzluk_id]);
        res.json(r.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/dof', async (req, res) => {
    try {
        const { uygunsuzluk_id, kok_neden, kapsam_etki, yayilma_etki, faaliyet_tanimi, sorumlu, termin, tamamlandi_tarihi, sonuc } = req.body;
        const r = await pool.query(
            `INSERT INTO dof (uygunsuzluk_id,kok_neden,kapsam_etki,yayilma_etki,faaliyet_tanimi,sorumlu,termin,tamamlandi_tarihi,sonuc)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [uygunsuzluk_id, kok_neden, kapsam_etki, yayilma_etki, faaliyet_tanimi, sorumlu, termin||null, tamamlandi_tarihi||null, sonuc]
        );
        res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/dof/:id', async (req, res) => {
    try {
        const { kok_neden, kapsam_etki, yayilma_etki, faaliyet_tanimi, sorumlu, termin, tamamlandi_tarihi, sonuc } = req.body;
        const r = await pool.query(
            `UPDATE dof SET kok_neden=$1,kapsam_etki=$2,yayilma_etki=$3,faaliyet_tanimi=$4,sorumlu=$5,termin=$6,tamamlandi_tarihi=$7,sonuc=$8 WHERE id=$9 RETURNING *`,
            [kok_neden, kapsam_etki, yayilma_etki, faaliyet_tanimi, sorumlu, termin||null, tamamlandi_tarihi||null, sonuc, req.params.id]
        );
        res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/dof/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM dof WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- İÇ DENETİM ---
app.get('/api/ic-denetim', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM ic_denetim ORDER BY olusturma_tarihi DESC');
        res.json(r.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/ic-denetim', async (req, res) => {
    try {
        const { denetim_no, plan_tarihi, tamamlandi_tarihi, kapsam, denetci, durum, aciklama } = req.body;
        const r = await pool.query(
            `INSERT INTO ic_denetim (denetim_no,plan_tarihi,tamamlandi_tarihi,kapsam,denetci,durum,aciklama)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [denetim_no, plan_tarihi||null, tamamlandi_tarihi||null, kapsam, denetci, durum||'planlandı', aciklama]
        );
        res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/ic-denetim/:id', async (req, res) => {
    try {
        const { denetim_no, plan_tarihi, tamamlandi_tarihi, kapsam, denetci, durum, aciklama } = req.body;
        const r = await pool.query(
            `UPDATE ic_denetim SET denetim_no=$1,plan_tarihi=$2,tamamlandi_tarihi=$3,kapsam=$4,denetci=$5,durum=$6,aciklama=$7 WHERE id=$8 RETURNING *`,
            [denetim_no, plan_tarihi||null, tamamlandi_tarihi||null, kapsam, denetci, durum, aciklama, req.params.id]
        );
        res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/ic-denetim/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM ic_denetim WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- İÇ DENETİM BULGU ---
app.get('/api/ic-denetim-bulgu/:denetim_id', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM ic_denetim_bulgu WHERE denetim_id=$1 ORDER BY id', [req.params.denetim_id]);
        res.json(r.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/ic-denetim-bulgu', async (req, res) => {
    try {
        const { denetim_id, bulgu_turu, madde_no, aciklama, durum, kapanis_tarihi } = req.body;
        const r = await pool.query(
            `INSERT INTO ic_denetim_bulgu (denetim_id,bulgu_turu,madde_no,aciklama,durum,kapanis_tarihi)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [denetim_id, bulgu_turu, madde_no, aciklama, durum||'acik', kapanis_tarihi||null]
        );
        res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/ic-denetim-bulgu/:id', async (req, res) => {
    try {
        const { bulgu_turu, madde_no, aciklama, durum, kapanis_tarihi } = req.body;
        const r = await pool.query(
            `UPDATE ic_denetim_bulgu SET bulgu_turu=$1,madde_no=$2,aciklama=$3,durum=$4,kapanis_tarihi=$5 WHERE id=$6 RETURNING *`,
            [bulgu_turu, madde_no, aciklama, durum, kapanis_tarihi||null, req.params.id]
        );
        res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/ic-denetim-bulgu/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM ic_denetim_bulgu WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- RİSK KAYDI ---
app.get('/api/risk-kaydi', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM risk_kaydi ORDER BY olusturma_tarihi DESC');
        res.json(r.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/risk-kaydi', async (req, res) => {
    try {
        const { risk_no, tarih, tur, kategori, tanim, etki, olasilik, onlem, sorumlu, termin, durum } = req.body;
        const skor = (parseInt(etki)||0) * (parseInt(olasilik)||0);
        const r = await pool.query(
            `INSERT INTO risk_kaydi (risk_no,tarih,tur,kategori,tanim,etki,olasilik,risk_skoru,onlem,sorumlu,termin,durum)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [risk_no, tarih||null, tur||'risk', kategori, tanim, etki||null, olasilik||null, skor||null, onlem, sorumlu, termin||null, durum||'acik']
        );
        res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/risk-kaydi/:id', async (req, res) => {
    try {
        const { risk_no, tarih, tur, kategori, tanim, etki, olasilik, onlem, sorumlu, termin, durum } = req.body;
        const skor = (parseInt(etki)||0) * (parseInt(olasilik)||0);
        const r = await pool.query(
            `UPDATE risk_kaydi SET risk_no=$1,tarih=$2,tur=$3,kategori=$4,tanim=$5,etki=$6,olasilik=$7,risk_skoru=$8,onlem=$9,sorumlu=$10,termin=$11,durum=$12 WHERE id=$13 RETURNING *`,
            [risk_no, tarih||null, tur||'risk', kategori, tanim, etki||null, olasilik||null, skor||null, onlem, sorumlu, termin||null, durum, req.params.id]
        );
        res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/risk-kaydi/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM risk_kaydi WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- MÜŞTERİ ŞİKAYETİ ---
app.get('/api/musteri-sikayet', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM musteri_sikayet ORDER BY olusturma_tarihi DESC');
        res.json(r.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/musteri-sikayet', async (req, res) => {
    try {
        const { sikayet_no, tarih, musteri_id, musteri_adi, aciklama, oncelik, durum, kapatis_tarihi, sonuc } = req.body;
        const r = await pool.query(
            `INSERT INTO musteri_sikayet (sikayet_no,tarih,musteri_id,musteri_adi,aciklama,oncelik,durum,kapatis_tarihi,sonuc)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [sikayet_no, tarih||null, musteri_id||null, musteri_adi, aciklama, oncelik||'orta', durum||'acik', kapatis_tarihi||null, sonuc]
        );
        res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/musteri-sikayet/:id', async (req, res) => {
    try {
        const { sikayet_no, tarih, musteri_id, musteri_adi, aciklama, oncelik, durum, kapatis_tarihi, sonuc } = req.body;
        const r = await pool.query(
            `UPDATE musteri_sikayet SET sikayet_no=$1,tarih=$2,musteri_id=$3,musteri_adi=$4,aciklama=$5,oncelik=$6,durum=$7,kapatis_tarihi=$8,sonuc=$9 WHERE id=$10 RETURNING *`,
            [sikayet_no, tarih||null, musteri_id||null, musteri_adi, aciklama, oncelik, durum, kapatis_tarihi||null, sonuc, req.params.id]
        );
        res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/musteri-sikayet/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM musteri_sikayet WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- DIŞ TEDARİKÇİ ---
app.get('/api/dis-tedarikci', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM dis_tedarikci ORDER BY olusturma_tarihi DESC');
        res.json(r.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/dis-tedarikci', async (req, res) => {
    try {
        const { firma_adi, hizmet_turu, iletisim, onay_durumu, aciklama } = req.body;
        const r = await pool.query(
            `INSERT INTO dis_tedarikci (firma_adi,hizmet_turu,iletisim,onay_durumu,aciklama) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
            [firma_adi, hizmet_turu, iletisim, onay_durumu||'beklemede', aciklama]
        );
        res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/dis-tedarikci/:id', async (req, res) => {
    try {
        const { firma_adi, hizmet_turu, iletisim, onay_durumu, aciklama } = req.body;
        const r = await pool.query(
            `UPDATE dis_tedarikci SET firma_adi=$1,hizmet_turu=$2,iletisim=$3,onay_durumu=$4,aciklama=$5 WHERE id=$6 RETURNING *`,
            [firma_adi, hizmet_turu, iletisim, onay_durumu, aciklama, req.params.id]
        );
        res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/dis-tedarikci/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM dis_tedarikci WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/dis-tedarikci-degerlendirme/:tedarikci_id', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM dis_tedarikci_degerlendirme WHERE tedarikci_id=$1 ORDER BY tarih DESC', [req.params.tedarikci_id]);
        res.json(r.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/dis-tedarikci-degerlendirme', async (req, res) => {
    try {
        const { tedarikci_id, tarih, puan, degerlendiren, notlar } = req.body;
        const r = await pool.query(
            `INSERT INTO dis_tedarikci_degerlendirme (tedarikci_id,tarih,puan,degerlendiren,notlar) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
            [tedarikci_id, tarih||null, puan||null, degerlendiren, notlar]
        );
        res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/dis-tedarikci-degerlendirme/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM dis_tedarikci_degerlendirme WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- YETERLİLİK TESTİ ---
app.get('/api/yeterlilik-testi', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM yeterlilik_testi ORDER BY olusturma_tarihi DESC');
        res.json(r.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/yeterlilik-testi', async (req, res) => {
    try {
        const { program_adi, organizator, katilim_tarihi, parametreler, sonuc, z_skoru, aciklama } = req.body;
        const r = await pool.query(
            `INSERT INTO yeterlilik_testi (program_adi,organizator,katilim_tarihi,parametreler,sonuc,z_skoru,aciklama)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [program_adi, organizator, katilim_tarihi||null, parametreler, sonuc||'beklemede', z_skoru, aciklama]
        );
        res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/yeterlilik-testi/:id', async (req, res) => {
    try {
        const { program_adi, organizator, katilim_tarihi, parametreler, sonuc, z_skoru, aciklama } = req.body;
        const r = await pool.query(
            `UPDATE yeterlilik_testi SET program_adi=$1,organizator=$2,katilim_tarihi=$3,parametreler=$4,sonuc=$5,z_skoru=$6,aciklama=$7 WHERE id=$8 RETURNING *`,
            [program_adi, organizator, katilim_tarihi||null, parametreler, sonuc, z_skoru, aciklama, req.params.id]
        );
        res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/yeterlilik-testi/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM yeterlilik_testi WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- YÖNETİMİN GÖZDEN GEÇİRMESİ ---
app.get('/api/ygg-toplanti', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM ygg_toplanti ORDER BY olusturma_tarihi DESC');
        res.json(r.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/ygg-toplanti', async (req, res) => {
    try {
        const { toplanti_no, tarih, katilimcilar, gundem, kararlar, durum, bir_sonraki_tarih } = req.body;
        const r = await pool.query(
            `INSERT INTO ygg_toplanti (toplanti_no,tarih,katilimcilar,gundem,kararlar,durum,bir_sonraki_tarih)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [toplanti_no, tarih||null, katilimcilar, gundem, kararlar, durum||'planlandı', bir_sonraki_tarih||null]
        );
        res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/ygg-toplanti/:id', async (req, res) => {
    try {
        const { toplanti_no, tarih, katilimcilar, gundem, kararlar, durum, bir_sonraki_tarih } = req.body;
        const r = await pool.query(
            `UPDATE ygg_toplanti SET toplanti_no=$1,tarih=$2,katilimcilar=$3,gundem=$4,kararlar=$5,durum=$6,bir_sonraki_tarih=$7 WHERE id=$8 RETURNING *`,
            [toplanti_no, tarih||null, katilimcilar, gundem, kararlar, durum, bir_sonraki_tarih||null, req.params.id]
        );
        res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/ygg-toplanti/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM ygg_toplanti WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- TÜRKAK API ---
app.post('/api/turkak-token-test', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) 
            return res.status(400).json({ error: "Kullanıcı adı ve şifre zorunludur!" });

        const response = await fetch('https://api.turkak.org.tr/SSO/signin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ Username: username, Password: password })
        });

        if (!response.ok) 
            return res.status(401).json({ error: "TÜRKAK kullanıcı adı veya şifre hatalı!" });

        const data = await response.json();
        const token = data.Token || data.token;

        if (!token) 
            return res.status(401).json({ error: "Token alınamadı. Bilgilerinizi kontrol edin." });

        // Token'ı geçici olarak sakla (ayarlar tablosuna)
        const zaman = new Date().toLocaleString('tr-TR');
        await pool.query(
            `INSERT INTO ayarlar (anahtar, deger) VALUES ($1, $2)
             ON CONFLICT (anahtar) DO UPDATE SET deger = $2`,
            ['turkak_token', token]
        );
        await pool.query(
            `INSERT INTO ayarlar (anahtar, deger) VALUES ($1, $2)
             ON CONFLICT (anahtar) DO UPDATE SET deger = $2`,
            ['turkak_token_zaman', zaman]
        );

        res.json({ success: true, zaman });
    } catch (err) { 
        res.status(500).json({ error: "TÜRKAK sunucusuna ulaşılamadı: " + err.message }); 
    }
});

// Token yenile (12 saatte bir çağrılır)
app.post('/api/turkak-token-yenile', async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT deger FROM ayarlar WHERE anahtar IN ('turkak_username','turkak_password')"
        );
        const ayarlar = {};
        result.rows.forEach(r => ayarlar[r.anahtar] = r.deger);

        if (!ayarlar.turkak_username || !ayarlar.turkak_password)
            return res.status(400).json({ error: "Türkak bilgileri kayıtlı değil!" });

        const response = await fetch('https://api.turkak.org.tr/SSO/signin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                Username: ayarlar.turkak_username, 
                Password: ayarlar.turkak_password 
            })
        });

        const rawText = await response.text();

console.log('TÜRKAK token status:', response.status);
console.log('TÜRKAK token raw response:', rawText);

let data;
try {
    data = JSON.parse(rawText);
} catch (e) {
    return res.status(500).json({
        error: `TÜRKAK token cevabı JSON değil. Status: ${response.status}`,
        raw: rawText
    });
}

const token = data.Token || data.token;
        if (!token) return res.status(401).json({ error: "Token yenilenemedi!" });

        const zaman = new Date().toLocaleString('tr-TR');
        await pool.query(
            `INSERT INTO ayarlar (anahtar, deger) VALUES ('turkak_token', $1)
             ON CONFLICT (anahtar) DO UPDATE SET deger = $1`, [token]);
        await pool.query(
            `INSERT INTO ayarlar (anahtar, deger) VALUES ('turkak_token_zaman', $1)
             ON CONFLICT (anahtar) DO UPDATE SET deger = $1`, [zaman]);

        res.json({ success: true, zaman });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Aktif token getir
app.get('/api/turkak-token', async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT deger FROM ayarlar WHERE anahtar='turkak_token'"
        );
        if (!result.rows.length) 
            return res.status(404).json({ error: "Token bulunamadı. Ayarlardan bağlantı kurun." });
        res.json({ token: result.rows[0].deger });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ÇEVRE KOŞULLARI ---
app.get('/api/cevre-kosullari', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT ck.*, k.kategori_adi
            FROM cevre_kosullari ck
            LEFT JOIN kategoriler k ON ck.kategori_id = k.id
            ORDER BY k.kategori_adi ASC`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cevre-kosullari/kategori/:kategori_id', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT ck.*, k.kategori_adi FROM cevre_kosullari ck
             LEFT JOIN kategoriler k ON ck.kategori_id = k.id
             WHERE ck.kategori_id = $1`,
            [req.params.kategori_id]
        );
        res.json(result.rows[0] || null);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cevre-kosullari', async (req, res) => {
    try {
        const { kategori_id, sicaklik_merkez, sicaklik_tolerans,
                nem_merkez, nem_tolerans, basinc_merkez, basinc_tolerans } = req.body;
        const result = await pool.query(
            `INSERT INTO cevre_kosullari
             (kategori_id, sicaklik_merkez, sicaklik_tolerans, nem_merkez, nem_tolerans, basinc_merkez, basinc_tolerans)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [kategori_id, sicaklik_merkez||null, sicaklik_tolerans||null,
             nem_merkez||null, nem_tolerans||null, basinc_merkez||null, basinc_tolerans||null]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/cevre-kosullari/:id', async (req, res) => {
    try {
        const { kategori_id, sicaklik_merkez, sicaklik_tolerans,
                nem_merkez, nem_tolerans, basinc_merkez, basinc_tolerans } = req.body;
        const result = await pool.query(
            `UPDATE cevre_kosullari SET
             kategori_id=$1, sicaklik_merkez=$2, sicaklik_tolerans=$3,
             nem_merkez=$4, nem_tolerans=$5, basinc_merkez=$6, basinc_tolerans=$7
             WHERE id=$8 RETURNING *`,
            [kategori_id, sicaklik_merkez||null, sicaklik_tolerans||null,
             nem_merkez||null, nem_tolerans||null, basinc_merkez||null, basinc_tolerans||null,
             req.params.id]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/cevre-kosullari/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM cevre_kosullari WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// SMTP transporter oluştur (ayarlardan)
async function smtpTransporter() {
    const res = await pool.query(
        "SELECT anahtar, deger FROM ayarlar WHERE anahtar IN ('smtp_host','smtp_port','smtp_user','smtp_pass','smtp_from_name','smtp_secure')"
    );
    const a = {};
    res.rows.forEach(r => a[r.anahtar] = r.deger);
    if(!a.smtp_host || !a.smtp_user || !a.smtp_pass)
        throw new Error('SMTP ayarları eksik. Lütfen Ayarlar sayfasından yapılandırın.');
    return nodemailer.createTransport({
        host: a.smtp_host,
        port: parseInt(a.smtp_port || '587'),
        secure: a.smtp_secure === 'true',
        auth: { user: a.smtp_user, pass: a.smtp_pass },
        connectionTimeout: 10000,
        socketTimeout: 10000,
        tls: { rejectUnauthorized: false }
    });
}

// --- SERTİFİKALAR ---
app.get('/api/sertifikalar', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                s.id, s.ie_id, s.ie_no, s.musteri_id, s.cihaz_index,
                s.cihaz_adi, s.imalatci, s.tip, s.seri_no, s.envanter_no,
                s.fis_no, s.kal_yeri, s.sertifika_tipi, s.sertifika_no,
                s.kal_tarihi, s.yayin_tarihi, s.onay_tarihi, s.gelecek_kal,
                s.kal_yapan_id, s.onaylayan_id, s.sicaklik, s.nem, s.basinc,
                s.uygunluk, s.yorum, s.asama, s.olusturulma,
                s.olcum_pdf_sayfa,
                -- PDF var mı bilgisi (base64 verisi değil)
                CASE WHEN s.olcum_pdf_url IS NOT NULL AND s.olcum_pdf_url != '' 
                     THEN true ELSE false END as olcum_pdf_var,
                CASE WHEN s.sertifika_pdf IS NOT NULL AND s.sertifika_pdf != '' 
                     THEN true ELSE false END as imzali_pdf_var,
                m.firma_adi, m.sube_adi,
                p1.ad_soyad as kal_yapan_adi,
                p2.ad_soyad as onaylayan_adi
            FROM sertifikalar s
            LEFT JOIN musteriler m ON s.musteri_id = m.id
            LEFT JOIN personeller p1 ON s.kal_yapan_id = p1.id
            LEFT JOIN personeller p2 ON s.onaylayan_id = p2.id
            ORDER BY s.olusturulma DESC`);
        res.json(result.rows);
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/sertifikalar', async (req, res) => {
    try {
        const { ie_id, ie_no, musteri_id, cihaz_index, cihaz_adi, imalatci, tip,
                seri_no, envanter_no, fis_no, kal_yeri, sertifika_tipi,
                kal_tarihi, yayin_tarihi, onay_tarihi, gelecek_kal,
                kal_yapan_id, onaylayan_id, sicaklik, nem, basinc,
                uygunluk, yorum, asama } = req.body;

        // Aynı iş emri + cihaz index için sertifika var mı kontrol
        const mevcut = await pool.query(
            'SELECT id FROM sertifikalar WHERE ie_id=$1 AND cihaz_index=$2',
            [ie_id, cihaz_index]
        );
        if(mevcut.rows.length)
            return res.status(400).json({ error: "Bu cihaz için zaten sertifika mevcut! Düzenleme yapın." });

        const result = await pool.query(`
            INSERT INTO sertifikalar
            (ie_id, ie_no, musteri_id, cihaz_index, cihaz_adi, imalatci, tip,
             seri_no, envanter_no, fis_no, kal_yeri, sertifika_tipi,
             kal_tarihi, yayin_tarihi, onay_tarihi, gelecek_kal,
             kal_yapan_id, onaylayan_id, sicaklik, nem, basinc,
             uygunluk, yorum, asama)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
            RETURNING *`,
            [ie_id, ie_no, musteri_id, cihaz_index, cihaz_adi, imalatci, tip,
             seri_no, envanter_no||null, fis_no, kal_yeri, sertifika_tipi,
             kal_tarihi, yayin_tarihi, onay_tarihi, gelecek_kal||null,
             kal_yapan_id||null, onaylayan_id||null, sicaklik, nem, basinc,
             uygunluk, yorum||null, asama||'hazırlanıyor']
        );
        res.json(result.rows[0]);
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/sertifikalar/:id', async (req, res) => {
    try {
        const { cihaz_adi, imalatci, tip, seri_no, envanter_no, fis_no, kal_yeri,
                sertifika_tipi, kal_tarihi, yayin_tarihi, onay_tarihi, gelecek_kal,
                kal_yapan_id, onaylayan_id, sicaklik, nem, basinc, uygunluk, yorum } = req.body;
        const result = await pool.query(`
            UPDATE sertifikalar SET
            cihaz_adi=$1, imalatci=$2, tip=$3, seri_no=$4, envanter_no=$5,
            fis_no=$6, kal_yeri=$7, sertifika_tipi=$8, kal_tarihi=$9,
            yayin_tarihi=$10, onay_tarihi=$11, gelecek_kal=$12,
            kal_yapan_id=$13, onaylayan_id=$14, sicaklik=$15, nem=$16,
            basinc=$17, uygunluk=$18, yorum=$19
            WHERE id=$20 RETURNING *`,
            [cihaz_adi, imalatci, tip, seri_no, envanter_no||null,
             fis_no, kal_yeri, sertifika_tipi, kal_tarihi,
             yayin_tarihi, onay_tarihi, gelecek_kal||null,
             kal_yapan_id||null, onaylayan_id||null, sicaklik, nem,
             basinc, uygunluk, yorum||null, req.params.id]
        );
        res.json(result.rows[0]);
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/sertifikalar/:id/asama', async (req, res) => {
    try {
        const { asama } = req.body;
        const result = await pool.query(
            'UPDATE sertifikalar SET asama=$1 WHERE id=$2 RETURNING *',
            [asama, req.params.id]
        );
        res.json(result.rows[0]);
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/sertifikalar/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM sertifikalar WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// Sertifika tam veri (önizleme için)
app.get('/api/sertifikalar/:id/tam', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT s.*,
                m.firma_adi, m.adres as firma_adres_ham, m.il, m.ilce,
                p1.ad_soyad as kal_yapan_adi,
                p2.ad_soyad as onaylayan_adi,
                mc.kalibrasyon_yeri,
                COALESCE(
                    (SELECT json_agg(json_build_object('talimat_kodu', t.talimat_kodu, 'talimat_adi', t.talimat_adi))
                     FROM talimatlar t WHERE t.id = ANY(km.talimatlar)), '[]'
                ) as talimat_detay,
                COALESCE(
                    (SELECT json_agg(json_build_object(
                        'cihaz_adi', rc.cihaz_adi, 'marka', rc.marka, 'model', rc.model,
                        'seri_no', rc.seri_no, 'envanter_no', rc.envanter_no
                    ))
                    FROM referans_cihazlar rc WHERE rc.id = ANY(km.referanslar)), '[]'
                ) as referans_detay
            FROM sertifikalar s
            LEFT JOIN musteriler m ON s.musteri_id = m.id
            LEFT JOIN personeller p1 ON s.kal_yapan_id = p1.id
            LEFT JOIN personeller p2 ON s.onaylayan_id = p2.id
            LEFT JOIN is_emirleri ie ON s.ie_id = ie.id
            LEFT JOIN musteri_cihazlari mc ON (ie.cihazlar->s.cihaz_index->>'musteri_cihaz_id')::int = mc.id
            LEFT JOIN kalibrasyon_metotlari km ON mc.metot_id = km.id
            WHERE s.id = $1
        `, [req.params.id]);
        if(!result.rows.length) return res.status(404).json({ error: 'Bulunamadı' });
        const row = result.rows[0];
        // Firma adres birleştir
        const adresParcalar = [];
        if(row.firma_adres_ham) adresParcalar.push(row.firma_adres_ham);
        const ilIlce = [row.ilce, row.il].filter(Boolean).join(' / ');
        if(ilIlce) adresParcalar.push(ilIlce);
        row.firma_adres = adresParcalar.join(' - ');
        res.json(row);
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// Sertifika PDF üret (Puppeteer)
app.get('/api/sertifikalar/:id/pdf', async (req, res) => {
    let browser;
    try {
        // Ölçüm PDF'ini DB'den çek
        const sertRow = await pool.query(
            'SELECT olcum_pdf_url, sertifika_no, cihaz_adi FROM sertifikalar WHERE id=$1',
            [req.params.id]
        );
        if(!sertRow.rows.length) return res.status(404).json({ error: 'Sertifika bulunamadı' });
        const sert = sertRow.rows[0];

        // S1+S2 HTML → PDF (Puppeteer)
        const onizleUrl = `${req.protocol}://${req.get('host')}/sertifika-onizle.html?id=${req.params.id}&print=1`;
        // Railway'de sistem Chromium'unu kullan
        const execPath = process.env.CHROMIUM_PATH ||
            require('child_process').execSync('which chromium || which chromium-browser || which google-chrome || echo ""')
            .toString().trim();

        browser = await puppeteer.launch({
            executablePath: execPath,
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-extensions',
            ],
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 794, height: 1123 });
        await page.goto(onizleUrl, { waitUntil: 'networkidle0', timeout: 30000 });
        await page.waitForSelector('.a4', { timeout: 10000 }).catch(()=>{});
        await new Promise(r => setTimeout(r, 1500));

        const s1s2Buffer = await page.pdf({
            format: 'A4',
            margin: { top: '0', right: '0', bottom: '0', left: '0' },
            printBackground: true,
            preferCSSPageSize: true,
        });

        // Lab ayarlarını çek (footer için - browser açıkken)
        const ayarRows = await pool.query('SELECT anahtar, deger FROM ayarlar');
        const ayar = ayarRows.rows.reduce((o, r) => { o[r.anahtar] = r.deger; return o; }, {});
        const labAdi   = ayar.lab_adi   || '';
        const labAdres = ayar.adres     || ayar.lab_adres || '';
        const labTel   = ayar.telefon   || ayar.lab_tel   || '';
        const labWeb   = ayar.website   || ayar.lab_web   || '';
        const labMail  = ayar.email     || ayar.lab_mail  || '';

        // Footer HTML → PDF (Puppeteer ile, browser hâlâ açık)
        const footerHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8">
        <style>*{margin:0;padding:0;box-sizing:border-box}
        body{width:794px;height:72px;background:white;font-family:Arial,sans-serif;padding:4px 15px 2px}
        .line1{border-top:0.6px solid #aaa;padding-top:3px;display:flex;justify-content:space-between;font-size:7px;color:#555}
        .line2{border-top:0.3px solid #ccc;margin-top:3px;padding-top:2px;font-size:6px;color:#555;line-height:1.45}
        </style></head><body>
        <div class="line1"><span>${labAdi}  ${labAdres}</span><span>${[labTel?'Tel: '+labTel:'',labWeb,labMail].filter(Boolean).join('  |  ')}</span></div>
        <div class="line2">
          Bu sertifika, laboratuvarin yazili izni olmadan kismen kopyalanip cogaltilamaz. | Imzasiz ve TURKAK Dogrulama Kare Kodu bulunmayan sertifikalar gecersizdir.<br>
          Bu sertifikanin kullanimindan once asist.turkak.org.tr uzerinden kare kodu okutarak dogrulayiniz.<br>
          This certificate shall not be reproduced other than in full except with the permission of the laboratory. | Certificates unsigned or without TURKAK QR code are invalid.<br>
          Before using this certificate, verify it by scanning the QR code via asist.turkak.org.tr.
        </div></body></html>`;

        const footerPage = await browser.newPage();
        await footerPage.setViewport({ width: 794, height: 72 });
        await footerPage.setContent(footerHtml, { waitUntil: 'networkidle0' });
        const footerBuffer = await footerPage.pdf({
            width: '794px', height: '72px',
            margin: { top: '0', right: '0', bottom: '0', left: '0' },
            printBackground: true,
        });

        await browser.close();
        browser = null;

        let sonPdfBuffer;

        // Ölçüm PDF varsa birleştir
        if(sert.olcum_pdf_url) {
            const olcumBytes = Buffer.from(sert.olcum_pdf_url, 'base64');
            const birlesikDoc = await PDFDocument.create();

            // S1+S2 sayfaları ekle
            const s1s2Doc = await PDFDocument.load(s1s2Buffer);
            const s1s2Pages = await birlesikDoc.copyPages(s1s2Doc, s1s2Doc.getPageIndices());
            s1s2Pages.forEach(p => birlesikDoc.addPage(p));

            // Footer PDF'ini XObject olarak göm
            const [embFooter] = await birlesikDoc.embedPdf(footerBuffer, [0]);
            const footerH = 72 * (841.89 / 1122.52); // px → pt (A4 oranı)

            // Ölçüm sayfalarını yeni A4 sayfalara XObject olarak yerleştir
            const embOlcumPages = await birlesikDoc.embedPdf(olcumBytes);
            const pageW = 595.28, pageH = 841.89;
            const copiedPages = []; // compat

            // Her ölçüm sayfasını yeni A4'e XObject(ölçüm) + XObject(footer) olarak yerleştir
            for (const embOlcum of embOlcumPages) {
                const newPage = birlesikDoc.addPage([pageW, pageH]);
                const contentH = pageH - footerH;
                const { width: oW, height: oH } = embOlcum;
                const scale = Math.min(pageW / oW, contentH / oH);
                const scaledW = oW * scale;
                const scaledH = oH * scale;
                const xOff = (pageW - scaledW) / 2;
                // Ölçüm içeriği - üst alana
                newPage.drawPage(embOlcum, { x: xOff, y: footerH, width: scaledW, height: scaledH });
                // Footer - alt alana (Puppeteer ile render edilmiş HTML)
                newPage.drawPage(embFooter, { x: 0, y: 0, width: pageW, height: footerH });
            }

            const birlesikBytes = await birlesikDoc.save();
            sonPdfBuffer = Buffer.from(birlesikBytes);
        } else {
            sonPdfBuffer = s1s2Buffer;
        }

        // DB'ye kaydet
        await pool.query(
            'UPDATE sertifikalar SET sertifika_pdf=$1 WHERE id=$2',
            [sonPdfBuffer.toString('base64'), req.params.id]
        );

        const dosyaAdi = `sertifika-${sert.sertifika_no || req.params.id}.pdf`;
        const preview = req.query.preview === '1';
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `${preview ? 'inline' : 'attachment'}; filename="${dosyaAdi}"`);
        res.send(sonPdfBuffer);

    } catch(err) {
        if(browser) await browser.close().catch(()=>{});
        console.error('PDF üretim hata:', err);
        res.status(500).json({ error: err.message });
    }
});

// QR kod üret (sertifika görüntüleme linki)
app.get('/api/sertifikalar/:id/qr', async (req, res) => {
    try {
        const host = `${req.protocol}://${req.get('host')}`;
        // QR → onaylanan/imzalı PDF'i aç
        const url  = `${host}/api/sertifikalar/${req.params.id}/onaylanan-pdf`;
        const qrDataUrl = await QRCode.toDataURL(url, {
            width: 120, margin: 1,
            color: { dark: '#000000', light: '#ffffff' }
        });
        res.json({ qr: qrDataUrl, url });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// Ölçüm PDF yükle
app.post('/api/sertifikalar/:id/olcum-pdf', async (req, res) => {
    try {
        const { pdf_base64, sayfa_sayisi } = req.body;
        if(!pdf_base64) return res.status(400).json({ error: 'PDF verisi eksik' });
        // R2'ye yükle, DB'ye sadece key kaydet
        const key = `olcum/${req.params.id}_olcum.pdf`;
        const buffer = Buffer.from(pdf_base64, 'base64');
        await r2Yukle(key, buffer);
        const result = await pool.query(
            `UPDATE sertifikalar SET olcum_pdf_url=$1, olcum_pdf_sayfa=$2 WHERE id=$3 RETURNING id, olcum_pdf_sayfa`,
            [key, sayfa_sayisi||0, req.params.id]
        );
        res.json(result.rows[0]);
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// Ölçüm PDF getir (önizleme)
app.get('/api/sertifikalar/:id/olcum-pdf', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT olcum_pdf_url, olcum_pdf_sayfa FROM sertifikalar WHERE id=$1',
            [req.params.id]
        );
        if(!result.rows.length) return res.status(404).json({ error: 'Bulunamadı' });
        const row = result.rows[0];
        if(!row.olcum_pdf_url) return res.status(404).json({ error: 'PDF yok' });
        const buffer = await r2Indir(row.olcum_pdf_url);
        res.json({ olcum_pdf_url: buffer.toString('base64'), olcum_pdf_sayfa: row.olcum_pdf_sayfa });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// SMTP test endpoint
app.post('/api/smtp-test', async (req, res) => {
    try {
        const ayarRes = await pool.query(
            "SELECT anahtar, deger FROM ayarlar WHERE anahtar IN ('smtp_user','smtp_from_name','lab_adi')"
        );
        const a = {};
        ayarRes.rows.forEach(r => a[r.anahtar] = r.deger);
        const transporter = await smtpTransporter();
        await transporter.sendMail({
            from: `"${a.smtp_from_name||a.lab_adi||'LabQMS'}" <${a.smtp_user}>`,
            to: a.smtp_user,
            subject: 'LabQMS Pro - SMTP Test',
            html: '<p>SMTP bağlantısı başarılı! LabQMS Pro mail sistemi çalışıyor.</p>'
        });
        res.json({ ok: true });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// Mail gönder (tek) - nodemailer + R2 imzalı PDF
app.post('/api/sertifika-mail/:id', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT s.id, s.asama, s.sertifika_pdf, s.sertifika_no, s.cihaz_adi,
                   s.imalatci, s.seri_no, s.envanter_no, s.kal_tarihi,
                   m.firma_adi, m.sube_adi, m.sertifika_mailleri
            FROM sertifikalar s
            LEFT JOIN musteriler m ON s.musteri_id = m.id
            WHERE s.id=$1`, [req.params.id]);

        if(!result.rows.length) return res.status(404).json({ error: 'Sertifika bulunamadı' });
        const s = result.rows[0];

        if(!s.sertifika_pdf)
            return res.status(400).json({ error: 'Bu sertifika henüz imzalanmamış!' });
        if(s.asama !== 'onaylandı')
            return res.status(400).json({ error: `Sertifika onaylanmamış (${s.asama})` });

        const mailler = s.sertifika_mailleri || [];
        if(!mailler.length)
            return res.status(400).json({ error: 'Müşteri sertifika mail adresi tanımlı değil!' });

        const ayarRes = await pool.query(
            "SELECT anahtar, deger FROM ayarlar WHERE anahtar IN ('lab_adi','smtp_user','smtp_from_name')"
        );
        const ayar = {};
        ayarRes.rows.forEach(r => ayar[r.anahtar] = r.deger);

        // İmzalı PDF R2'den indir
        const pdfBuffer = await r2Indir(s.sertifika_pdf);

        const firmaAdi = s.sube_adi ? `${s.firma_adi} - ${s.sube_adi}` : s.firma_adi;
        const kalTarihi = s.kal_tarihi ? new Date(s.kal_tarihi).toLocaleDateString('tr-TR') : '-';
        const labAdi = ayar.lab_adi || 'Kalibrasyon Laboratuvarı';

        const htmlIcerik = `
        <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;padding:20px;">
            <div style="background:#1E40AF;color:white;padding:20px;border-radius:8px 8px 0 0;">
                <h2 style="margin:0;">${labAdi}</h2>
                <p style="margin:5px 0 0;">Kalibrasyon Sertifikası Bildirimi</p>
            </div>
            <div style="background:#f8fafc;padding:20px;border:1px solid #e2e8f0;">
                <p>Sayın <strong>${firmaAdi}</strong>,</p>
                <p>Aşağıda bilgileri yer alan cihazınıza ait kalibrasyon sertifikasına ulaşabilirsiniz.</p>
                <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                    <tr style="background:#1E40AF;color:white;">
                        <th style="padding:10px;text-align:left;">Cihaz</th>
                        <th style="padding:10px;text-align:left;">Marka/Model</th>
                        <th style="padding:10px;text-align:left;">Seri No</th>
                        <th style="padding:10px;text-align:left;">Envanter No</th>
                        <th style="padding:10px;text-align:left;">Kal. Tarihi</th>
                        <th style="padding:10px;text-align:center;">Sertifika No</th>
                    </tr>
                    <tr style="background:white;">
                        <td style="padding:10px;border-bottom:1px solid #e2e8f0;">${s.cihaz_adi||'-'}</td>
                        <td style="padding:10px;border-bottom:1px solid #e2e8f0;">${s.imalatci||'-'}</td>
                        <td style="padding:10px;border-bottom:1px solid #e2e8f0;">${s.seri_no||'-'}</td>
                        <td style="padding:10px;border-bottom:1px solid #e2e8f0;">${s.envanter_no||'-'}</td>
                        <td style="padding:10px;border-bottom:1px solid #e2e8f0;">${kalTarihi}</td>
                        <td style="padding:10px;border-bottom:1px solid #e2e8f0;text-align:center;"><strong>${s.sertifika_no||'-'}</strong></td>
                    </tr>
                </table>
                <p style="color:#64748b;font-size:0.85rem;">Sertifika PDF dosyası bu mailin ekinde bulunmaktadır.</p>
            </div>
            <div style="background:#e2e8f0;padding:12px;border-radius:0 0 8px 8px;text-align:center;font-size:0.8rem;color:#64748b;">
                ${labAdi} | Bu mail otomatik gönderilmiştir.
            </div>
        </div>`;

        const transporter = await smtpTransporter();
        await transporter.sendMail({
            from: `"${ayar.smtp_from_name||labAdi}" <${ayar.smtp_user}>`,
            to: mailler.join(', '),
            subject: `Kalibrasyon Sertifikası - ${s.sertifika_no||s.cihaz_adi} - ${firmaAdi}`,
            html: htmlIcerik,
            attachments: [{
                filename: `Sertifika_${s.sertifika_no||s.id}.pdf`,
                content: pdfBuffer,
                contentType: 'application/pdf'
            }]
        });

        await pool.query(
            "UPDATE sertifikalar SET asama='sertifika_gönderildi' WHERE id=$1",
            [req.params.id]
        );

        res.json({ success: true, mesaj: `Mail ${mailler.join(', ')} adresine gönderildi.` });
    } catch(err) {
        console.error('Mail gönderme hata:', err);
        res.status(500).json({ error: err.message });
    }
});

// Mail gönder (toplu)


// Sertifika numarası otomatik üret
app.post('/api/sertifika-no-uret', async (req, res) => {
    try {
        const { sertifika_id } = req.body;

        // Ayarlardan format ve sayac al
        const ayarlar = await pool.query(
            "SELECT anahtar, deger FROM ayarlar WHERE anahtar IN ('kd_format','kd_sayac','kd_basamak','akreditasyon_no')"
        );
        const ayar = {};
        ayarlar.rows.forEach(r => ayar[r.anahtar] = r.deger);

        const format   = ayar.kd_format  || 'SERT-{YIL}-{SAYI}';
        const basamak  = parseInt(ayar.kd_basamak || '3');
        const mevcutSayac = parseInt(ayar.kd_sayac || '0');
        const yeniSayac   = mevcutSayac + 1;

        // Formatı doldur
        const yil  = new Date().getFullYear();
        const ay   = String(new Date().getMonth() + 1).padStart(2, '0');
        const sayi = String(yeniSayac).padStart(basamak, '0');

        let sertNo = format
            .replace(/{YIL}/g, yil)
            .replace(/{YY}/g, String(yil).slice(-2))
            .replace(/{AY}/g, ay)
            .replace(/{SAYI}/g, sayi);

        // Sayacı güncelle
        await pool.query(
            "INSERT INTO ayarlar (anahtar, deger) VALUES ('kd_sayac', $1) ON CONFLICT (anahtar) DO UPDATE SET deger=$1",
            [String(yeniSayac)]
        );

        // Sertifikaya no ata
        if (sertifika_id) {
            await pool.query(
                'UPDATE sertifikalar SET sertifika_no=$1 WHERE id=$2',
                [sertNo, sertifika_id]
            );
        }

        res.json({ sertifika_no: sertNo, sayac: yeniSayac });

    } catch (err) {
        console.error('Sertifika no üretme hata:', err);
        res.status(500).json({ error: err.message });
    }
});


// TÜRKAK Akredite Sertifika No Alma
app.post('/api/turkak/akredite-no-ver-toplu', async (req, res) => {
    try {

        const { idler } = req.body;

        if(!idler || !idler.length){
            return res.status(400).json({ error: "Sertifika seçilmedi" });
        }

        const tokenResult = await pool.query(
            "SELECT deger FROM ayarlar WHERE anahtar='turkak_token'"
        );

        if(!tokenResult.rows.length){
            return res.status(400).json({ error: "Türkak token bulunamadı" });
        }

        const token = tokenResult.rows[0].deger;

        for(const id of idler){

            const s = await pool.query(`
                SELECT s.*, m.turkak_id AS musteri_turkak_id
                FROM sertifikalar s
                LEFT JOIN musteriler m ON s.musteri_id = m.id
                WHERE s.id=$1
            `,[id]);

            if(!s.rows.length) continue;

            const sertifika = s.rows[0];

            if(!sertifika.musteri_turkak_id){
                console.log("Müşteri Türkak ID yok:", id);
                continue;
            }

            const payload = [{
                CustomerID: sertifika.musteri_turkak_id,
                CalibrationDate: sertifika.kal_tarihi,
                FirstReleaseDateOfTheDocument: sertifika.yayin_tarihi,
                MachineOrDeviceType: sertifika.cihaz_adi,
                DeviceSerialNumber: sertifika.seri_no
            }];

            const response = await fetch(
                'https://api.turkak.org.tr/TBDS/api/v1/CalibrationService/CalibrationCertificateSaveData/',
                {
                    method:'POST',
                    headers:{
                        'Content-Type':'application/json',
                        'Authorization': `Bearer ${token}`

                    },
                    body: JSON.stringify(payload)
                }
            );

            const rawText = await response.text();

console.log('TBDS save status:', response.status);
console.log('TBDS save raw response:', rawText);
console.log("TOKEN LENGTH:", token.length);
console.log("TOKEN START:", token.slice(0,20));

let data;
try {
    data = JSON.parse(rawText);
} catch (e) {
    throw new Error(`TBDS save JSON değil. Status: ${response.status}, Cevap: ${rawText}`);
}

            const turkakId =
                data?.Item1?.[0]?.ID ||
                data?.item1?.[0]?.id ||
                null;

            if(!turkakId){
                console.log("Türkak ID alınamadı:", data);
                continue;
            }

            await pool.query(
                `UPDATE sertifikalar
                 SET turkak_id=$2, turkak_durum='Taslak'
                 WHERE id=$1`,
                [id, turkakId]
            );

            await new Promise(r=>setTimeout(r,2000));

            const detayRes = await fetch(
                `https://api.turkak.org.tr/TBDS/api/v1/CalibrationService/CalibrationCertificateGetCertificate/${turkakId}`,
                {
                    headers:{
                        'Authorization': `Bearer ${token}`

                    }
                }
            );

            const detayText = await detayRes.text();

console.log('TBDS detail status:', detayRes.status);
console.log('TBDS detail raw response:', detayText);

let detay;
try {
    detay = JSON.parse(detayText);
} catch (e) {
    throw new Error(`TBDS detail JSON değil. Status: ${detayRes.status}, Cevap: ${detayText}`);
}

            const tbdsNo = detay?.TBDSNumber || null;
            const turkakNo = detay?.CertificationBodyDocumentNumber || null;
            const state = detay?.State || 'Taslak';

            await pool.query(`
                UPDATE sertifikalar
                SET
                sertifika_no=$2,
                tbds_no=$3,
                turkak_durum=$4
                WHERE id=$1
            `,[id, turkakNo, tbdsNo, state]);

        }

        res.json({ success:true });

    } catch(err){
        console.error("Türkak işlem hatası:",err);
        res.status(500).json({ error: err.message });
    }
});

// Onaylanan PDF'i tarayıcıda aç (QR linki)
app.get('/api/sertifikalar/:id/onaylanan-pdf', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT sertifika_pdf, sertifika_no, asama FROM sertifikalar WHERE id=$1',
            [req.params.id]
        );
        if (!result.rows.length) return res.status(404).send('Sertifika bulunamadı');
        const s = result.rows[0];
        if (!s.sertifika_pdf) return res.status(404).send('Onaylanan PDF henüz yok');
        const buffer = await r2Indir(s.sertifika_pdf);
        const dosyaAdi = `sertifika_${s.sertifika_no || req.params.id}.pdf`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${dosyaAdi}"`);
        res.send(buffer);
    } catch(err) {
        res.status(500).send(err.message);
    }
});

// İmzalı PDF'i base64 olarak döndür (onaylama imzası için)
app.get('/api/sertifikalar/:id/imzali-pdf', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT sertifika_pdf, sertifika_no, asama FROM sertifikalar WHERE id=$1',
            [req.params.id]
        );
        if(!result.rows.length) return res.status(404).json({ error: 'Sertifika bulunamadı' });
        const s = result.rows[0];
        if(!s.sertifika_pdf) return res.status(404).json({ error: 'İmzalı PDF bulunamadı' });
        if(!['imzalandı','onaylandı','sertifika_gönderildi'].includes(s.asama)) 
            return res.status(400).json({ error: 'Sertifika henüz imzalanmamış' });
        const buffer = await r2Indir(s.sertifika_pdf);
        res.json({ pdf_base64: buffer.toString('base64'), sertifika_no: s.sertifika_no });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// EronSign - İmzalı PDF yükle ve aşamayı güncelle
app.post('/api/imzali-pdf-yukle', async (req, res) => {
    try {
        const { sertifika_id, pdf_base64, dosya_adi } = req.body;
        if (!sertifika_id || !pdf_base64) {
            return res.status(400).json({ error: 'sertifika_id ve pdf_base64 zorunlu' });
        }

        // Mevcut aşamayı öğren
        const mevcut = await pool.query('SELECT asama FROM sertifikalar WHERE id=$1', [sertifika_id]);
        if (!mevcut.rows.length) return res.status(404).json({ error: 'Sertifika bulunamadı' });

        const mevcutAsama = mevcut.rows[0].asama;

        // Aşama geçişi: hazırlanıyor → imzalandı, imzalandı → onaylandı
        let yeniAsama = mevcutAsama;
        if (mevcutAsama === 'hazırlanıyor') yeniAsama = 'imzalandı';
        else if (mevcutAsama === 'imzalandı') yeniAsama = 'onaylandı';

        // R2'ye yükle, DB'ye key kaydet
        const imzaKey = `imzali/${sertifika_id}_${yeniAsama.replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;
        await r2Yukle(imzaKey, Buffer.from(pdf_base64, 'base64'));
        await pool.query(
            'UPDATE sertifikalar SET sertifika_pdf=$1, asama=$2 WHERE id=$3',
            [imzaKey, yeniAsama, sertifika_id]
        );

        console.log(`[EronSign] Sertifika #${sertifika_id}: ${mevcutAsama} → ${yeniAsama}`);
        res.json({ ok: true, sertifika_id, eski_asama: mevcutAsama, yeni_asama: yeniAsama });

    } catch (err) {
        console.error('İmzalı PDF yükleme hata:', err);
        res.status(500).json({ error: err.message });
    }
});

// Toplu mail için veri hazırla (frontend yerel servise gönderecek)
app.post('/api/sertifika-mail-toplu-veri', async (req, res) => {
    try {
        const { idler } = req.body;
        const result = await pool.query(`
            SELECT s.id, s.sertifika_no, s.cihaz_adi, s.imalatci, s.seri_no, s.envanter_no,
                   s.kal_tarihi, s.sertifika_pdf, s.asama, s.musteri_id,
                   m.firma_adi, m.sube_adi, m.sertifika_mailleri
            FROM sertifikalar s
            LEFT JOIN musteriler m ON s.musteri_id = m.id
            WHERE s.id=ANY($1)`, [idler]);

        const ayarRes = await pool.query(
            "SELECT anahtar, deger FROM ayarlar WHERE anahtar IN ('lab_adi','smtp_host','smtp_port','smtp_user','smtp_pass','smtp_secure','smtp_from_name')"
        );
        const a = {};
        ayarRes.rows.forEach(r => a[r.anahtar] = r.deger);

        const labAdi = a.lab_adi || 'Kalibrasyon Laboratuvarı';
        const baseUrl = process.env.BASE_URL || 'https://labqms-pro.up.railway.app';

        const grupMap = {};
        for (const s of result.rows) {
            if (s.asama !== 'onaylandı' || !s.sertifika_pdf) continue;
            const key = s.musteri_id || 'genel';
            if (!grupMap[key]) grupMap[key] = { mailler: s.sertifika_mailleri || [], firma: s.sube_adi ? `${s.firma_adi} - ${s.sube_adi}` : s.firma_adi, sertifikalar: [] };
            grupMap[key].sertifikalar.push(s);
        }

        const gruplar = Object.values(grupMap).filter(g => g.mailler.length).map(grup => {
            const grupIdler = grup.sertifikalar.map(s => s.id);
            const zipLink = `${baseUrl}/api/sertifika-pdf-zip?idler=${grupIdler.join(',')}`;
            const satirlar = grup.sertifikalar.map(s => {
                const kal = s.kal_tarihi ? new Date(s.kal_tarihi).toLocaleDateString('tr-TR') : '-';
                const pdfLink = `${baseUrl}/api/sertifika-pdf-indir/${s.id}`;
                return `<tr><td style="padding:10px;border-bottom:1px solid #e2e8f0;">${s.cihaz_adi||'-'}</td>
                    <td style="padding:10px;border-bottom:1px solid #e2e8f0;">${s.imalatci||'-'}</td>
                    <td style="padding:10px;border-bottom:1px solid #e2e8f0;">${s.seri_no||'-'}</td>
                    <td style="padding:10px;border-bottom:1px solid #e2e8f0;">${s.envanter_no||'-'}</td>
                    <td style="padding:10px;border-bottom:1px solid #e2e8f0;">${kal}</td>
                    <td style="padding:10px;border-bottom:1px solid #e2e8f0;text-align:center;"><strong>${s.sertifika_no||'-'}</strong></td>
                    <td style="padding:10px;border-bottom:1px solid #e2e8f0;text-align:center;">
                        <a href="${pdfLink}" style="background:#1E40AF;color:white;padding:5px 12px;border-radius:4px;text-decoration:none;font-size:0.8rem;">⬇ İndir</a>
                    </td></tr>`;
            }).join('');
            const html = `<div style="font-family:Arial,sans-serif;max-width:750px;margin:0 auto;padding:20px;">
                <div style="background:#1E40AF;color:white;padding:20px;border-radius:8px 8px 0 0;">
                    <h2 style="margin:0;">${labAdi}</h2><p style="margin:5px 0 0;">Kalibrasyon Sertifikaları</p>
                </div>
                <div style="background:#f8fafc;padding:20px;border:1px solid #e2e8f0;">
                    <p>Sayın <strong>${grup.firma}</strong>,</p>
                    <p>Aşağıda bilgileri yer alan cihazlarınıza ait kalibrasyon sertifikalarına ulaşabilirsiniz.</p>
                    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                        <tr style="background:#1E40AF;color:white;">
                            <th style="padding:10px;text-align:left;">Cihaz</th>
                            <th style="padding:10px;text-align:left;">Marka</th>
                            <th style="padding:10px;text-align:left;">Seri No</th>
                            <th style="padding:10px;text-align:left;">Envanter No</th>
                            <th style="padding:10px;text-align:left;">Kal. Tarihi</th>
                            <th style="padding:10px;text-align:center;">Sertifika No</th>
                            <th style="padding:10px;text-align:center;">PDF</th>
                        </tr>
                        ${satirlar}
                    </table>
                    <div style="text-align:center;margin-top:16px;">
                        <a href="${zipLink}" style="background:#059669;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">📦 Tümünü ZIP İndir</a>
                    </div>
                </div>
                <div style="background:#e2e8f0;padding:12px;border-radius:0 0 8px 8px;text-align:center;font-size:0.8rem;color:#64748b;">
                    ${labAdi} | Bu mail otomatik gönderilmiştir.
                </div>
            </div>`;
            return { mailler: grup.mailler, konu: `Kalibrasyon Sertifikaları - ${grup.firma}`, html, adet: grupIdler.length };
        });

        res.json({ gruplar, smtp: { host: a.smtp_host, port: a.smtp_port, user: a.smtp_user, pass: a.smtp_pass, secure: a.smtp_secure, from_name: a.smtp_from_name } });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// Toplu mail sonrası aşama güncelle
app.post('/api/sertifika-mail-toplu-guncelle', async (req, res) => {
    try {
        const { idler } = req.body;
        await pool.query("UPDATE sertifikalar SET asama='sertifika_gönderildi' WHERE id=ANY($1) AND asama='onaylandı'", [idler]);
        res.json({ ok: true });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// Sertifika PDF indirme (mail linki için)
app.get('/api/sertifika-pdf-indir/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT sertifika_pdf, sertifika_no FROM sertifikalar WHERE id=$1', [req.params.id]);
        if (!result.rows.length || !result.rows[0].sertifika_pdf) return res.status(404).send('Bulunamadı');
        const s = result.rows[0];
        const buf = await r2Indir(s.sertifika_pdf);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Sertifika_${s.sertifika_no||req.params.id}.pdf"`);
        res.send(buf);
    } catch(err) { res.status(500).send(err.message); }
});

// Toplu ZIP indirme
app.get('/api/sertifika-pdf-zip', async (req, res) => {
    try {
        const idler = (req.query.idler||'').split(',').map(Number).filter(Boolean);
        if (!idler.length) return res.status(400).send('idler gerekli');
        const rows = (await pool.query('SELECT id, sertifika_no, sertifika_pdf FROM sertifikalar WHERE id=ANY($1)', [idler])).rows;
        const archiver = require('archiver');
        const archive = archiver('zip', { zlib: { level: 6 } });
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="Sertifikalar.zip"');
        archive.pipe(res);
        for (const s of rows) {
            if (s.sertifika_pdf) {
                const buf = await r2Indir(s.sertifika_pdf);
                archive.append(buf, { name: `Sertifika_${s.sertifika_no||s.id}.pdf` });
            }
        }
        await archive.finalize();
    } catch(err) { console.error('ZIP hata:', err); }
});

// Toplu mail gönder
app.post('/api/sertifika-mail-toplu', async (req, res) => {
    try {
        const { idler } = req.body;
        if (!idler || !idler.length) return res.status(400).json({ error: 'Sertifika seçilmedi' });

        const result = await pool.query(`
            SELECT s.id, s.sertifika_no, s.cihaz_adi, s.imalatci, s.seri_no, s.envanter_no,
                   s.kal_tarihi, s.sertifika_pdf, s.asama, s.musteri_id,
                   m.firma_adi, m.sube_adi, m.sertifika_mailleri
            FROM sertifikalar s
            LEFT JOIN musteriler m ON s.musteri_id = m.id
            WHERE s.id=ANY($1)`, [idler]);

        const ayarRes = await pool.query(
            "SELECT anahtar, deger FROM ayarlar WHERE anahtar IN ('lab_adi','smtp_user','smtp_from_name')"
        );
        const ayar = {};
        ayarRes.rows.forEach(r => ayar[r.anahtar] = r.deger);
        const labAdi = ayar.lab_adi || 'Kalibrasyon Laboratuvarı';
        const baseUrl = process.env.BASE_URL || 'https://labqms-pro.up.railway.app';

        // Müşteriye göre grupla
        const gruplar = {};
        for (const s of result.rows) {
            if (s.asama !== 'onaylandı' || !s.sertifika_pdf) continue;
            const key = s.musteri_id || 'genel';
            if (!gruplar[key]) gruplar[key] = { mailler: s.sertifika_mailleri || [], firma: s.sube_adi ? `${s.firma_adi} - ${s.sube_adi}` : s.firma_adi, sertifikalar: [] };
            gruplar[key].sertifikalar.push(s);
        }

        const transporter = await smtpTransporter();
        let basarili = 0;

        for (const grup of Object.values(gruplar)) {
            if (!grup.mailler.length) continue;
            const grupIdler = grup.sertifikalar.map(s => s.id);
            const zipLink = `${baseUrl}/api/sertifika-pdf-zip?idler=${grupIdler.join(',')}`;

            const satirlar = grup.sertifikalar.map(s => {
                const kal = s.kal_tarihi ? new Date(s.kal_tarihi).toLocaleDateString('tr-TR') : '-';
                const pdfLink = `${baseUrl}/api/sertifika-pdf-indir/${s.id}`;
                return `<tr style="background:white;">
                    <td style="padding:10px;border-bottom:1px solid #e2e8f0;">${s.cihaz_adi||'-'}</td>
                    <td style="padding:10px;border-bottom:1px solid #e2e8f0;">${s.imalatci||'-'}</td>
                    <td style="padding:10px;border-bottom:1px solid #e2e8f0;">${s.seri_no||'-'}</td>
                    <td style="padding:10px;border-bottom:1px solid #e2e8f0;">${s.envanter_no||'-'}</td>
                    <td style="padding:10px;border-bottom:1px solid #e2e8f0;">${kal}</td>
                    <td style="padding:10px;border-bottom:1px solid #e2e8f0;text-align:center;"><strong>${s.sertifika_no||'-'}</strong></td>
                    <td style="padding:10px;border-bottom:1px solid #e2e8f0;text-align:center;">
                        <a href="${pdfLink}" style="background:#1E40AF;color:white;padding:5px 12px;border-radius:4px;text-decoration:none;font-size:0.8rem;">⬇ İndir</a>
                    </td>
                </tr>`;
            }).join('');

            const html = `<div style="font-family:Arial,sans-serif;max-width:750px;margin:0 auto;padding:20px;">
                <div style="background:#1E40AF;color:white;padding:20px;border-radius:8px 8px 0 0;">
                    <h2 style="margin:0;">${labAdi}</h2>
                    <p style="margin:5px 0 0;">Kalibrasyon Sertifikaları</p>
                </div>
                <div style="background:#f8fafc;padding:20px;border:1px solid #e2e8f0;">
                    <p>Sayın <strong>${grup.firma}</strong>,</p>
                    <p>Aşağıda bilgileri yer alan cihazlarınıza ait kalibrasyon sertifikalarına ulaşabilirsiniz.</p>
                    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                        <tr style="background:#1E40AF;color:white;">
                            <th style="padding:10px;text-align:left;">Cihaz</th>
                            <th style="padding:10px;text-align:left;">Marka</th>
                            <th style="padding:10px;text-align:left;">Seri No</th>
                            <th style="padding:10px;text-align:left;">Envanter No</th>
                            <th style="padding:10px;text-align:left;">Kal. Tarihi</th>
                            <th style="padding:10px;text-align:center;">Sertifika No</th>
                            <th style="padding:10px;text-align:center;">PDF</th>
                        </tr>
                        ${satirlar}
                    </table>
                    <div style="text-align:center;margin-top:16px;">
                        <a href="${zipLink}" style="background:#059669;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">📦 Tümünü ZIP İndir</a>
                    </div>
                </div>
                <div style="background:#e2e8f0;padding:12px;border-radius:0 0 8px 8px;text-align:center;font-size:0.8rem;color:#64748b;">
                    ${labAdi} | Bu mail otomatik gönderilmiştir.
                </div>
            </div>`;

            await transporter.sendMail({
                from: `"${ayar.smtp_from_name||labAdi}" <${ayar.smtp_user}>`,
                to: grup.mailler.join(', '),
                subject: `Kalibrasyon Sertifikaları - ${grup.firma}`,
                html
            });
            basarili += grupIdler.length;
        }

        await pool.query(
            "UPDATE sertifikalar SET asama='sertifika_gönderildi' WHERE id=ANY($1) AND asama='onaylandı'",
            [idler]
        );

        res.json({ success: true, basarili });
    } catch(err) {
        console.error('Toplu mail hata:', err);
        res.status(500).json({ error: err.message });
    }
});

// Chromium path bilgisi (debug)
app.get('/api/chromium-path', (req, res) => {
    const { execSync } = require('child_process');
    try {
        const p = execSync('which chromium 2>/dev/null || which chromium-browser 2>/dev/null || which google-chrome 2>/dev/null || find /nix /usr -name "chromium" -type f 2>/dev/null | head -1 || echo "not found"', { timeout: 5000 }).toString().trim();
        res.json({ path: p });
    } catch(e) { res.json({ path: 'error', err: e.message }); }
});
