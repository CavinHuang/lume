# Task 09 - Secret Storage Encryption

## Goal
Securely store API keys using local encrypted file strategy.

## In Scope
- Implement `SecretStore` abstraction.
- Add encrypted file backend using key derivation and authenticated encryption.
- Support set/get/rotate key flow.

## Out of Scope
- macOS Keychain implementation (future extension).

## Deliverables
1. Secret storage module in Sidecar.
2. User settings flow for API key setup/update.
3. Migration-safe metadata table.

## Acceptance Criteria
1. API key is never stored in plaintext.
2. Decryption fails safely on tampered ciphertext.
3. Claude calls work after app restart with stored key.

## Dependencies
- `08-web-search-provider-layer`.

## Completion Note
- Pending.

