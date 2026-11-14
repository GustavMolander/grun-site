// Decrypts data/real.enc produced by grun/crypto.py:
// gzip(JSON) -> AES-256-GCM, key = PBKDF2-SHA256(password, salt, iter).
// Everything happens locally in the browser; the password is never sent anywhere.

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const KEY_STORE = 'grun.key';

export async function deriveKey(password, blob) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64(blob.salt), iterations: blob.iter, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
}

export async function decryptWithKey(key, blob) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(blob.iv) }, key, b64(blob.ct));
  const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

// Remember the derived key (not the password), bound to this ciphertext's salt.
export async function storeKey(key, blob, persistent) {
  const raw = await crypto.subtle.exportKey('raw', key);
  const val = JSON.stringify({ salt: blob.salt, key: toB64(raw) });
  try { (persistent ? localStorage : sessionStorage).setItem(KEY_STORE, val); } catch (e) { /* storage blocked */ }
}

export async function loadStoredKey(blob) {
  let val = null;
  try { val = sessionStorage.getItem(KEY_STORE) || localStorage.getItem(KEY_STORE); } catch (e) { return null; }
  if (!val) return null;
  const { salt, key } = JSON.parse(val);
  if (salt !== blob.salt) return null; // data re-encrypted with a new salt: ask again
  return crypto.subtle.importKey('raw', b64(key), { name: 'AES-GCM' }, false, ['decrypt']);
}

export function forgetKey() {
  try { sessionStorage.removeItem(KEY_STORE); localStorage.removeItem(KEY_STORE); } catch (e) { /* ignore */ }
}
