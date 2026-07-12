# Chat E2E Encryption

BetterDesk Chat uses end-to-end encryption with ECDH key exchange and AES-256-GCM. No server can read the messages.

---

## Protocol Overview

```
User A                          Server                         User B
  |                               |                               |
  |--- key_exchange (pubkey_A) -->|--- key_exchange (pubkey_A) -->|
  |<-- key_exchange (pubkey_B) ---|<-- key_exchange (pubkey_B) ---|
  |                               |                               |
  | [ECDH: shared_secret = dh(privA, pubB)]                      |
  | [HKDF-SHA256: key = derive(shared_secret, salt)]             |
  |                               |                               |
  |--- encrypted message -------->|--- encrypted message -------->|
  |<-- encrypted message ---------|<-- encrypted message ---------|
```

---

## Key Exchange

### Algorithm: ECDH P-256

1. Each client generates an **ECDH P-256 key pair** using WebCrypto API
2. Public keys are exchanged via the `key_exchange` message through the server
3. Shared secret is derived via **ECDH Diffie-Hellman**
4. AES-256 encryption key is derived from the shared secret via **HKDF-SHA256**
5. Key pairs persist in `localStorage` across sessions

### Key Rotation

Keys rotate automatically when either condition is met:
- **24 hours** since last rotation
- **1000 messages** sent with current key

On rotation, a new key exchange is performed seamlessly.

---

## Message Encryption

### Algorithm: AES-256-GCM

Each message is encrypted with:
- **Algorithm:** AES-256-GCM
- **Key:** 256-bit derived key from ECDH + HKDF
- **IV:** 12-byte random nonce (unique per message)
- **Authentication tag:** 128-bit GCM tag

### Encrypted Message Format

```json
{
  "type": "message",
  "encrypted": true,
  "iv": "<base64-encoded IV>",
  "data": "<base64-encoded ciphertext>",
  "tag": "<included in GCM ciphertext>"
}
```

The server relays the `data` field without decryption. Only the intended recipient can decrypt.

---

## File Encryption

Files up to 50 MB can be sent with E2E encryption:

### Algorithm

Same AES-256-GCM with separate IVs for metadata and file data.

### Packed Format

```
[metaIV (12 bytes)] [metaLen (4 bytes)] [encryptedMeta] [dataIV (12 bytes)] [encryptedData]
```

### Encrypted Metadata

```json
{
  "filename": "report.pdf",
  "size": 1048576,
  "timestamp": 1711929600000
}
```

---

## Message Types

The chat protocol supports these E2E-aware message types:

| Type | Direction | Encrypted | Description |
|------|-----------|-----------|-------------|
| `key_exchange` | Both | ❌ | Public key exchange (plaintext) |
| `message` | Both | ✅ | Text message |
| `file_share` | Both | ✅ | File metadata + encrypted file |
| `read_receipt` | Both | ❌ | Array of read message IDs |
| `typing` | Both | ❌ | Typing indicator |
| `presence_update` | Both | ❌ | Online/away/busy status |
| `hello` | Server→Client | ❌ | Server greeting |
| `welcome` | Server→Client | ❌ | Server capabilities confirmation |
| `status` | Server→Client | ❌ | Connection status update |

---

## Server Capabilities

The server announces capabilities in the `welcome` message:

```json
{
  "type": "welcome",
  "capabilities": [
    "e2e_encryption",
    "read_receipts",
    "typing",
    "presence",
    "file_share"
  ],
  "server_time": 1711929600000
}
```

---

## Implementation

### Client Side (`chatCrypto.js`)

```javascript
// Key generation
const keyPair = await crypto.subtle.generateKey(
  { name: 'ECDH', namedCurve: 'P-256' },
  true, ['deriveBits']
);

// Key derivation
const sharedBits = await crypto.subtle.deriveBits(
  { name: 'ECDH', public: peerPublicKey },
  keyPair.privateKey, 256
);
const aesKey = await crypto.subtle.deriveKey(
  { name: 'HKDF', hash: 'SHA-256', salt: salt, info: info },
  baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
);

// Encryption
const iv = crypto.getRandomValues(new Uint8Array(12));
const ciphertext = await crypto.subtle.encrypt(
  { name: 'AES-GCM', iv: iv },
  aesKey, plaintext
);
```

### Server Side (`chatRelay.js`)

The server:
1. Receives `key_exchange` and forwards to the peer (plaintext relay)
2. Receives encrypted messages and forwards without decryption
3. Never has access to private keys or plaintext messages
4. Stores no messages (relay only)

---

## Security Properties

| Property | Status |
|----------|--------|
| **Forward secrecy** | ✅ Key rotation every 24h or 1000 messages |
| **Authentication** | ✅ Key pairs bound to authenticated sessions |
| **Integrity** | ✅ GCM authentication tag on every message |
| **Confidentiality** | ✅ AES-256-GCM with unique IVs |
| **Replay protection** | ✅ Unique IVs prevent replay |
| **Server-blind** | ✅ Server relays ciphertext only |

---

## Limitations

- Key exchange requires both parties online simultaneously
- No offline message queuing (relay model)
- File size limit: 50 MB per transfer
- Browser WebCrypto API required (no IE11 support)
- Key pairs stored in localStorage (cleared on browser data wipe)

---

## See also

- [[Security]] — overall security model
- [[Web Console|Web-Console]] — chat UI in panel
