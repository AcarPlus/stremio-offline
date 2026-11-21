// H5 / E10: BOM'lu ve bozuk ayar dosyaları (ayarlar.json, config.json, library.json).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Settings } from '../lib/settings.mjs'
import { loadConfig } from '../lib/config.mjs'
import { Library } from '../lib/library.mjs'
import { readJsonFile } from '../lib/jsonoku.mjs'

const BOM = '﻿'
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jsonoku-'))
const yedekler = (dir, ad) => fs.readdirSync(dir).filter(f => f.startsWith(ad + '.bozuk-'))

test('H5: BOM\'lu ayarlar.json okunur', () => {
  const dir = tmp()
  try {
    fs.writeFileSync(path.join(dir, 'ayarlar.json'), BOM + JSON.stringify({ defaultDownloadLimit: 300000, uploadLimit: 50000, priorityThrottle: 150000 }))
    const s = new Settings({ dataDir: dir })
    assert.deepEqual(s.get(), { defaultDownloadLimit: 300000, uploadLimit: 50000, priorityThrottle: 150000, seedLimit: 100000 })
    assert.equal(yedekler(dir, 'ayarlar.json').length, 0, 'sağlam dosya yedeklenmez')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('H5: bozuk ayarlar.json ezilmeden yedeklenir, varsayılanlarla açılır', () => {
  const dir = tmp()
  try {
    const f = path.join(dir, 'ayarlar.json')
    fs.writeFileSync(f, '{"defaultDownloadLimit": 300000,')
    const s = new Settings({ dataDir: dir })
    assert.equal(s.get().defaultDownloadLimit, 0)
    const b = yedekler(dir, 'ayarlar.json')
    assert.equal(b.length, 1, 'bozuk-<zaman> yedeği oluştu')
    assert.equal(fs.readFileSync(path.join(dir, b[0]), 'utf8'), '{"defaultDownloadLimit": 300000,')
    assert.equal(fs.readFileSync(f, 'utf8'), '{"defaultDownloadLimit": 300000,', 'özgün dosyaya dokunulmadı')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('H5: dosya yoksa sessiz, yedek yok', () => {
  const dir = tmp()
  try {
    assert.equal(readJsonFile(path.join(dir, 'yok.json')).status, 'yok')
    new Settings({ dataDir: dir })
    assert.equal(fs.readdirSync(dir).length, 0)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

function withEnv (dir, fn) {
  const old = process.env.OFFLINE_DATA_DIR
  const kapilar = { OFFLINE_PORT: '39001', OFFLINE_RQBIT_PORT: '39002', OFFLINE_PEER_PORT: '39003', OFFLINE_ENGINE_API_BASE: '39010', OFFLINE_ENGINE_PEER_BASE: '39110' }
  const eski = Object.fromEntries(Object.keys(kapilar).map(k => [k, process.env[k]]))
  process.env.OFFLINE_DATA_DIR = dir
  Object.assign(process.env, kapilar)
  try { return fn() } finally {
    if (old === undefined) delete process.env.OFFLINE_DATA_DIR; else process.env.OFFLINE_DATA_DIR = old
    for (const [k, v] of Object.entries(eski)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
}

test('E10: BOM\'lu config.json okunur', () => {
  const dir = tmp()
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), BOM + JSON.stringify({ metadataTimeoutSec: 33 }))
    const cfg = withEnv(dir, () => loadConfig())
    assert.equal(cfg.metadataTimeoutSec, 33)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('E10: bozuk config.json yedeklenir ve ezilmez', () => {
  const dir = tmp()
  try {
    const f = path.join(dir, 'config.json')
    fs.writeFileSync(f, '{ bozuk')
    const cfg = withEnv(dir, () => loadConfig())
    assert.equal(cfg.metadataTimeoutSec, 90, 'varsayılanla açıldı')
    assert.equal(yedekler(dir, 'config.json').length, 1)
    assert.equal(fs.readFileSync(f, 'utf8'), '{ bozuk')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('BOM\'lu library.json okunur', () => {
  const dir = tmp()
  try {
    const f = path.join(dir, 'library.json')
    fs.writeFileSync(f, BOM + JSON.stringify({ version: 2, items: [{ infoHash: 'a'.repeat(40), name: 'x', state: 'paused', files: [] }] }))
    const lib = new Library(f).load()
    assert.equal(lib.all().length, 1)
    assert.equal(yedekler(dir, 'library.json').length, 0)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('H7: sınama kipi kapılar verilmeden açılmaz (gerçek servisin aralığına girmez)', () => {
  const dir = tmp()
  const keys = ['OFFLINE_PORT', 'OFFLINE_RQBIT_PORT', 'OFFLINE_PEER_PORT', 'OFFLINE_ENGINE_API_BASE', 'OFFLINE_ENGINE_PEER_BASE', 'OFFLINE_DEBUG_PORT', 'OFFLINE_NO_INJECT']
  const eski = Object.fromEntries(keys.map(k => [k, process.env[k]]))
  for (const k of keys) delete process.env[k]
  process.env.OFFLINE_DATA_DIR = dir
  try {
    assert.throws(() => loadConfig(), /OFFLINE_RQBIT_PORT.*OFFLINE_ENGINE_API_BASE/)
    Object.assign(process.env, { OFFLINE_PORT: '39001', OFFLINE_RQBIT_PORT: '39002', OFFLINE_PEER_PORT: '39003', OFFLINE_ENGINE_API_BASE: '39010', OFFLINE_ENGINE_PEER_BASE: '39110' })
    assert.equal(loadConfig().inject, false, 'sınama kipinde Stremio kapısına gidilmez')
    process.env.OFFLINE_DEBUG_PORT = '39004'
    const c = loadConfig()
    assert.equal(c.inject, true); assert.equal(c.debugPort, 39004)
  } finally {
    delete process.env.OFFLINE_DATA_DIR
    for (const [k, v] of Object.entries(eski)) if (v === undefined) delete process.env[k]; else process.env[k] = v
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
