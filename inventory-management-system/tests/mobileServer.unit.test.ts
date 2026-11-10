import assert from 'node:assert/strict'
import test from 'node:test'
import { mobileServerDisplayName, normalizeMobileServerUrl } from '../src/mobileServer.ts'

test('normalizes a bare Digital Core Office domain to its inventory service', () => {
  assert.equal(normalizeMobileServerUrl('office.example.com'), 'https://office.example.com/inventory')
})

test('keeps an explicit inventory path and supports a suite subpath', () => {
  assert.equal(normalizeMobileServerUrl('https://office.example.com/inventory/'), 'https://office.example.com/inventory')
  assert.equal(normalizeMobileServerUrl('https://office.example.com/core-office'), 'https://office.example.com/core-office/inventory')
})

test('allows local HTTP development but requires HTTPS for remote servers', () => {
  assert.equal(normalizeMobileServerUrl('http://localhost:4187'), 'http://localhost:4187/inventory')
  assert.throws(() => normalizeMobileServerUrl('http://office.example.com'), /https/)
})

test('rejects credentials, query parameters, and fragments', () => {
  assert.throws(() => normalizeMobileServerUrl('https://user:secret@office.example.com'), /invalid/)
  assert.throws(() => normalizeMobileServerUrl('https://office.example.com?tenant=a'), /invalid/)
  assert.throws(() => normalizeMobileServerUrl('https://office.example.com#inventory'), /invalid/)
})

test('formats the configured server for compact display', () => {
  assert.equal(mobileServerDisplayName('https://office.example.com/inventory'), 'office.example.com/inventory')
})
