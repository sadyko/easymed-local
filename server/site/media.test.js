// WEBSITE_V1 — публичная раздача /media: свой бакет data/storage/website,
// отдельный от авторизованного /api/storage ЕРП (server/routes/storage.js).
// Обход пути должен быть невозможен теми же способами, что и в storage.js:
// '.', '..', обратный слэш, кодированный слэш.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSite } from './app.test.js';
import { seedDoctor } from './test-seed.js';
import { invalidateContentCache } from './content.js';

function makeMediaDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easymed-media-'));
  fs.writeFileSync(path.join(dir, 'test.png'), Buffer.from('fake-png-bytes'));
  fs.writeFileSync(path.join(dir, 'evil.txt'), 'nope');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'pic.webp'), Buffer.from('fake-webp-bytes'));
  return dir;
}

test('GET /media/<file> отдаёт картинку с правильным типом и кэшем', async () => {
  const mediaDir = makeMediaDir();
  const { server, base } = await startSite(null, { mediaDir });
  try {
    const res = await fetch(base + '/media/test.png');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /image\/png/);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=86400');
  } finally {
    server.close();
    fs.rmSync(mediaDir, { recursive: true, force: true });
  }
});

test('GET /media/<sub>/<file> обслуживает вложенные папки', async () => {
  const mediaDir = makeMediaDir();
  const { server, base } = await startSite(null, { mediaDir });
  try {
    const res = await fetch(base + '/media/sub/pic.webp');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /image\/webp/);
  } finally {
    server.close();
    fs.rmSync(mediaDir, { recursive: true, force: true });
  }
});

test('GET /media/<file> с недопустимым расширением — 404 HTML', async () => {
  const mediaDir = makeMediaDir();
  const { server, base } = await startSite(null, { mediaDir });
  try {
    const res = await fetch(base + '/media/evil.txt');
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /text\/html/);
  } finally {
    server.close();
    fs.rmSync(mediaDir, { recursive: true, force: true });
  }
});

test('обход пути (точки, кодированный слэш, обратный слэш) — везде 404', async () => {
  const mediaDir = makeMediaDir();
  const { server, base } = await startSite(null, { mediaDir });
  try {
    const r1 = await fetch(base + '/media/../app.test.js', { redirect: 'manual' });
    assert.equal(r1.status, 404);
    const r2 = await fetch(base + '/media/..%2F..%2Fserver%2Findex.js');
    assert.equal(r2.status, 404);
    const r3 = await fetch(base + '/media/a%5Cb.png');
    assert.equal(r3.status, 404);
  } finally {
    server.close();
    fs.rmSync(mediaDir, { recursive: true, force: true });
  }
});

// Реальная гонка (файл удалён/заблокирован МЕЖДУ statSync() и чтением потока)
// недетерминирована и её нельзя надёжно воспроизвести в тесте — здесь только
// проверка, что путь чтения потока в принципе жив и не роняет обработчик,
// в том числе на пустом файле (0 байт — граничный случай самого потока).
test('GET /media/<file> — пустой (0 байт) файл тоже стримится успешно', async () => {
  const mediaDir = makeMediaDir();
  fs.writeFileSync(path.join(mediaDir, 'empty.png'), Buffer.alloc(0));
  const { server, base } = await startSite(null, { mediaDir });
  try {
    const res = await fetch(base + '/media/empty.png');
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, 0);
  } finally {
    server.close();
    fs.rmSync(mediaDir, { recursive: true, force: true });
  }
});

test('GET /media/missing.png — 404', async () => {
  const mediaDir = makeMediaDir();
  const { server, base } = await startSite(null, { mediaDir });
  try {
    const res = await fetch(base + '/media/missing.png');
    assert.equal(res.status, 404);
  } finally {
    server.close();
    fs.rmSync(mediaDir, { recursive: true, force: true });
  }
});

test('GET /media/<file>.svg — Content-Type svg и жёсткий CSP на этот ответ', async () => {
  const mediaDir = makeMediaDir();
  fs.writeFileSync(path.join(mediaDir, 'icon.svg'), '<svg></svg>');
  const { server, base } = await startSite(null, { mediaDir });
  try {
    const res = await fetch(base + '/media/icon.svg');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'");
  } finally {
    server.close();
    fs.rmSync(mediaDir, { recursive: true, force: true });
  }
});

// WEBSITE_V1 (Easy-Med) — фото врача берётся из профиля, но ТОЛЬКО у показанного врача.
test('GET /media/doctor/<id> — фото показанного врача; скрытого — 404', async () => {
  invalidateContentCache();
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easymed-storage-'));
  fs.mkdirSync(path.join(storageDir, 'website'));
  const photo = (db, id, bytes) => {
    const dir = path.join(storageDir, 'doctor-photos', 'doctors', String(id));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'face.jpg'), Buffer.from(bytes));
    db.prepare('UPDATE users SET photo_url = ? WHERE id = ?').run('/api/storage/doctor-photos/doctors/' + id + '/face.jpg', id);
  };
  let shown, hidden;
  // mediaDir не передаётся: приложение само берёт <storageDir>/website, как в бою
  const { server, base, db } = await startSite((db) => {
    shown = seedDoctor(db, { ru: 'Показан Врач' });
    hidden = seedDoctor(db, { ru: 'Скрыт Врач', shown: false });
    photo(db, shown, 'shown-bytes'); photo(db, hidden, 'hidden-bytes');
  }, { storageDir });
  try {
    const ok = await fetch(base + '/media/doctor/' + shown);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /image\/jpeg/);
    assert.equal(Buffer.from(await ok.arrayBuffer()).toString(), 'shown-bytes');
    assert.equal((await fetch(base + '/media/doctor/' + hidden)).status, 404, 'скрытый врач по прямой ссылке не находится');
    assert.equal((await fetch(base + '/media/doctor/999999')).status, 404);
    assert.equal((await fetch(base + '/media/doctor/abc')).status, 404);
  } finally {
    server.close(); db.close();
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
});
