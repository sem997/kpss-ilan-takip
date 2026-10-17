// KPSS lisans ilan takip botu.
// ilan.gov.tr'deki kamu personel ilanlarını ve ÖSYM'nin KPSS tercih kılavuzlarını toplar,
// her ilanın metninden bölüm / KPSS / lisans bilgisini çıkarır ve data/*.json dosyalarına yazar.
// Çalıştırma: node scraper/guncelle.mjs   (Node 20+, ek paket gerekmez)

import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ilan.gov.tr sunucusu ara sertifikayı (GeoTrust TLS RSA CA G1) göndermiyor; Node da bu yüzden
// bağlantıyı reddediyor. Sertifikayı Node'a tanıtmak için bot kendini bir kez bu ayarla yeniden başlatır.
const SERTIFIKA = fileURLToPath(new URL("ara-sertifika.pem", import.meta.url));
if (!process.env.NODE_EXTRA_CA_CERTS) {
  const sonuc = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: { ...process.env, NODE_EXTRA_CA_CERTS: SERTIFIKA },
  });
  process.exit(sonuc.status ?? 1);
}

const KOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOSYA = (ad) => path.join(KOK, "data", ad);

const API = "https://www.ilan.gov.tr/api/api/services/app";
const PERSONEL_KATEGORI = 8; // ilan.gov.tr "Kamu-Akademik Personel" kategorisi
const SAYFA = 20; // site bir istekte en fazla 20 ilan veriyor
const KALDIRILAN_TUTMA_GUN = 30;

const BASLIK = {
  "Accept": "text/plain",
  "Content-Type": "application/json-patch+json",
  "X-Request-Origin": "IGT-UI",
  "X-Requested-With": "XMLHttpRequest",
  "Origin": "https://www.ilan.gov.tr",
  "Referer": "https://www.ilan.gov.tr/ilan/kategori/9/personel-alimlari",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
};

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));

async function istek(url, secenek = {}, deneme = 3) {
  for (let i = 1; ; i++) {
    try {
      const yanit = await fetch(url, { ...secenek, signal: AbortSignal.timeout(45000) });
      if (!yanit.ok) throw new Error(`HTTP ${yanit.status}`);
      return yanit;
    } catch (hata) {
      if (i >= deneme) throw new Error(`${url} -> ${hata.message}`);
      await bekle(2000 * i);
    }
  }
}

// ---------- Metin işleme ----------

const HARF = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", â: "a", î: "i", û: "u" };

// Türkçe büyük/küçük harf + aksan farkını kaldırır: "GIDA MÜHENDİSLİĞİ" -> "gida muhendisligi"
function sadelestir(metin) {
  return metin
    .toLocaleLowerCase("tr-TR")
    .replace(/[çğıöşüâîû]/g, (h) => HARF[h])
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function htmlMetne(html) {
  return (html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|tr|li|h\d)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

const GENEL_IFADELER = [
  "herhangi bir lisans", "herhangi bir fakulte", "herhangi bir bolum", "herhangi bir yuksekogretim",
  "lisans programlarinin herhangi", "lisans programlarindan herhangi", "fakultelerin herhangi",
  "dort yillik herhangi", "4 yillik herhangi", "tum lisans", "tum bolumler", "bolum sarti aranmaz",
  "bolumlerin herhangi", "herhangi birinden mezun",
];
const AKADEMIK = /ogretim uyesi|ogretim elemani|ogretim gorevlisi|arastirma gorevlisi|doktor ogretim|docent|profesor|akademik personel/;

function bolumleriBul(sade, bolumler) {
  const bulunan = [];
  for (const b of bolumler) {
    if (b.desenler.some((d) => d.test(sade))) bulunan.push(b.id);
  }
  return bulunan;
}

// Sadeleştirilmiş metinde "lisans" kelimesi (ön lisans / yüksek lisans hariç) geçiyor mu?
function lisansVar(sade) {
  return /(?<!on |yuksek )\blisans\b/.test(sade) || /\b4 yillik\b|\bdort yillik\b|\bfakulte/.test(sade);
}

function puanTurleri(sade) {
  const turler = new Set();
  for (const m of sade.matchAll(/\bkpss ?(?:p|b)? ?(\d{1,3})\b/g)) {
    const n = +m[1];
    if (n >= 1 && n <= 130) turler.add("P" + n);
  }
  for (const m of sade.matchAll(/\bkpssp ?(\d{1,3})\b/g)) turler.add("P" + m[1]);
  return [...turler].sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1))).slice(0, 6);
}

const AYLAR = ["ocak", "subat", "mart", "nisan", "mayis", "haziran", "temmuz", "agustos", "eylul", "ekim", "kasim", "aralik"];

function tarihCoz(parca) {
  let m = parca.match(/\b(\d{1,2}) (\d{1,2}) (20\d\d)\b/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = parca.match(new RegExp(`\\b(\\d{1,2}) (${AYLAR.join("|")}) (20\\d\\d)\\b`));
  if (m) return `${m[3]}-${String(AYLAR.indexOf(m[2]) + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

// "son başvuru tarihi" ya da "başvurular ... tarihleri arasında" ifadesinden bitiş tarihini bulur.
function sonBasvuru(sade) {
  const adaylar = [];
  for (const m of sade.matchAll(/son basvuru|basvuru bitis|basvurularin bitis/g)) {
    const t = tarihCoz(sade.slice(m.index, m.index + 120));
    if (t) adaylar.push(t);
  }
  if (!adaylar.length) {
    for (const m of sade.matchAll(/basvuru/g)) {
      const parca = sade.slice(m.index, m.index + 200);
      const ikili = parca.match(/(\d{1,2} \d{1,2} 20\d\d|\d{1,2} [a-z]+ 20\d\d)(?: saat \d{1,2} \d{2})? (?:ile|ve|-)? ?(\d{1,2} \d{1,2} 20\d\d|\d{1,2} [a-z]+ 20\d\d)/);
      if (ikili) { const t = tarihCoz(ikili[2]); if (t) adaylar.push(t); }
    }
  }
  return adaylar.sort().at(-1) || null;
}

// Bölüm adının geçtiği yerden kısa bir alıntı (orijinal yazımla).
function alinti(metin, bolum) {
  const satirlar = metin.split("\n");
  for (const s of satirlar) {
    const sade = sadelestir(s);
    if (bolum.desenler.some((d) => d.test(sade))) {
      return s.length > 260 ? s.slice(0, 257) + "…" : s;
    }
  }
  return null;
}

function analizEt(ilan, metin, bolumler) {
  const sade = sadelestir(ilan.baslik + "\n" + metin);
  const bulunan = bolumleriBul(sade, bolumler);
  const alintilar = {};
  for (const id of bulunan) {
    const a = alinti(metin, bolumler.find((b) => b.id === id));
    if (a) alintilar[id] = a;
  }
  return {
    kpss: /\bkpss/.test(sade),
    puanTurleri: puanTurleri(sade),
    lisans: lisansVar(sade),
    genel: GENEL_IFADELER.some((g) => sade.includes(g)),
    akademik: AKADEMIK.test(sadelestir(ilan.baslik + " " + (ilan.kategori || ""))) || /\bales\b/.test(sade) && !/\bkpss/.test(sade),
    bolumler: bulunan,
    alintilar,
    sonBasvuru: sonBasvuru(sade),
  };
}

// ---------- ilan.gov.tr ----------

async function personelListesi() {
  const liste = [];
  let toplam = Infinity;
  for (let atla = 0; atla < toplam && atla < 2000; atla += SAYFA) {
    const yanit = await istek(`${API}/Ad/AdsByFilter`, {
      method: "POST",
      headers: BASLIK,
      body: JSON.stringify({ keys: { txv: [PERSONEL_KATEGORI] }, skipCount: atla, maxResultCount: SAYFA }),
    });
    const { result } = await yanit.json();
    toplam = result.numFound ?? 0;
    if (!result.ads?.length) break;
    liste.push(...result.ads);
    await bekle(400);
  }
  return liste;
}

async function ilanDetay(id) {
  const yanit = await istek(`${API}/AdDetail/GetAdDetail?id=${encodeURIComponent(id)}`, { headers: BASLIK });
  return (await yanit.json()).result;
}

function filtreDegeri(dizi, anahtar) {
  return (dizi || []).find((f) => f.key === anahtar)?.value || null;
}

// ---------- ÖSYM ----------

function htmlCoz(s) {
  return htmlMetne(s).replace(/\s+/g, " ");
}

async function osymKilavuzlari() {
  const kaynaklar = ["https://www.osym.gov.tr/", "https://www.osym.gov.tr/SinavGrubu/Index/3"];
  const bulunan = new Map();
  for (const url of kaynaklar) {
    let html;
    try {
      html = await (await istek(url, { headers: { "User-Agent": BASLIK["User-Agent"] } }, 2)).text();
    } catch (hata) {
      console.warn("ÖSYM okunamadı:", hata.message);
      continue;
    }
    for (const m of html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const baslik = htmlCoz(m[2]) || htmlCoz((m[0].match(/title="([^"]*)"/) || [])[1] || "");
      const sade = sadelestir(baslik);
      if (/kpss/.test(sade) && /tercih kilavuz/.test(sade)) {
        const link = new URL(m[1].replace(/&amp;/g, "&"), url).href;
        if (!bulunan.has(link)) bulunan.set(link, baslik);
      }
    }
  }
  return [...bulunan].map(([link, baslik]) => ({ link, baslik }));
}

// ---------- Ana akış ----------

async function jsonOku(ad, varsayilan) {
  try { return JSON.parse(await readFile(DOSYA(ad), "utf8")); } catch { return varsayilan; }
}

async function jsonYaz(ad, veri) {
  await writeFile(DOSYA(ad), JSON.stringify(veri, null, 1) + "\n", "utf8");
}

async function main() {
  const simdi = new Date().toISOString();
  const bolumler = (await jsonOku("bolumler.json", [])).map((b) => ({ ...b, desenler: b.ara.map((r) => new RegExp(r)) }));

  const eski = await jsonOku("ilanlar.json", { ilanlar: [] });
  const metinler = await jsonOku("metinler.json", {}); // ilan metinleri (sadece botun kullandığı önbellek)
  const ilkKurulum = eski.ilanlar.length === 0;
  const eskiMap = new Map(eski.ilanlar.map((i) => [i.id, i]));

  const liste = await personelListesi();
  console.log(`ilan.gov.tr: ${liste.length} personel ilanı listelendi`);

  const guncel = new Map();
  let yeniSayisi = 0;
  for (const a of liste) {
    const id = String(a.id);
    if (guncel.has(id)) continue;
    const onceki = eskiMap.get(id);
    const ilan = {
      id,
      ilanNo: a.adNo,
      baslik: (a.title || "").trim(),
      kurum: (a.advertiserName || "").trim(),
      sehir: a.addressCityName || null,
      kategori: filtreDegeri(a.values, "Kategori"),
      yayin: a.publishStartDate || null,
      resmiGazete: filtreDegeri(a.adTypeFilters, "Resmî Gazete Yayım Tarihi"),
      link: "https://www.ilan.gov.tr" + (a.urlStr || `/ilan/${id}`),
      ilkGorulme: onceki?.ilkGorulme || (ilkKurulum ? a.publishStartDate || simdi : simdi),
      aktif: true,
    };
    if (!metinler[id]) {
      try {
        const detay = await ilanDetay(id);
        metinler[id] = htmlMetne(detay.content);
        await bekle(350);
      } catch (hata) {
        console.warn("Detay alınamadı:", id, hata.message);
        metinler[id] = "";
      }
    }
    if (!onceki) yeniSayisi++;
    Object.assign(ilan, analizEt(ilan, metinler[id], bolumler));
    guncel.set(id, ilan);
  }

  // Listeden düşen ilanları bir süre "kaldırıldı" olarak tut, sonra sil.
  const sinir = Date.now() - KALDIRILAN_TUTMA_GUN * 864e5;
  for (const [id, i] of eskiMap) {
    if (guncel.has(id)) continue;
    const kalkis = i.kaldirilma || simdi;
    if (Date.parse(kalkis) < sinir) { delete metinler[id]; continue; }
    guncel.set(id, { ...i, aktif: false, kaldirilma: kalkis });
  }
  for (const id of Object.keys(metinler)) if (!guncel.has(id)) delete metinler[id];

  const ilanlar = [...guncel.values()].sort((x, y) => (y.yayin || "").localeCompare(x.yayin || ""));

  // ÖSYM tercih kılavuzları
  const osymEski = await jsonOku("osym.json", { kilavuzlar: [] });
  const osymMap = new Map(osymEski.kilavuzlar.map((k) => [k.link, k]));
  // İlk kurulumda zaten yayında olan kılavuzlar "yeni" sayılmasın diye ilkGorulme boş bırakılır.
  const osymIlk = osymEski.kilavuzlar.length === 0;
  const kilavuzlar = (await osymKilavuzlari()).map((k) => {
    const onceki = osymMap.get(k.link);
    return { ...k, ilkGorulme: onceki ? onceki.ilkGorulme : osymIlk ? null : simdi };
  });

  await jsonYaz("ilanlar.json", {
    sonGuncelleme: simdi,
    kaynak: "ilan.gov.tr - Kamu Personel İlanları",
    ilanlar,
  });
  await jsonYaz("metinler.json", metinler);
  await jsonYaz("osym.json", { sonGuncelleme: simdi, kilavuzlar });

  console.log(`Bitti: ${ilanlar.filter((i) => i.aktif).length} aktif ilan, ${yeniSayisi} yeni, ${kilavuzlar.length} ÖSYM kılavuzu`);
}

main().catch((hata) => {
  console.error("HATA:", hata.message);
  process.exit(1);
});
