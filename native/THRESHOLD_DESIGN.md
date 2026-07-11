# Threshold Decryption Design — REFERENCE ONLY, NOT AUDITED

## Status
This document describes the architecture for the "multiparty" half of the
system. It is **not** shipped as working code in this repo, and should not be
deployed against real tenant data until a cryptography specialist has
reviewed the noise-flooding parameters and the share-transport protocol.
Getting threshold LWE decryption wrong (insufficient noise flooding, weak
share distribution, no malicious-party detection) can leak the secret key —
this is a common failure mode in homemade threshold-crypto implementations,
which is why established literature exists specifically to avoid it.

## What "decentralized functional bootstrapping" actually cannot mean here
There is no published, production-ready construction for N parties jointly
performing the bootstrapping step of TFHE (blind rotation against a shared
bootstrapping key) without any party holding — or being able to reconstruct —
the full secret key. This is open research, not an engineering gap. Anything
claiming to ship this as a library feature should be treated with suspicion.

## What IS real and implementable: threshold decryption
Separate from bootstrapping, **threshold decryption** of an LWE ciphertext is
well-established (Boneh et al. 2018; Asharov et al. 2012 for the general LWE
case). The idea:

1. The tenant's secret key `s` is never generated whole on any single machine.
   Instead, `t`-of-`N` tenant-controlled nodes each hold a Shamir share `s_i`
   of the key, generated via a distributed key-generation ceremony (no single
   party — including Forge — ever sees the reconstructed `s`).
2. Forge performs all homomorphic computation (the real part, above) using
   only the public server key, producing a result ciphertext `c_result`.
3. To reveal the plaintext, each of the `t` participating tenant nodes
   computes a **partial decryption** of `c_result` using its share `s_i`,
   adding a small amount of statistical "noise flooding" to its partial
   result to prevent share-leakage from the partial decryption itself.
4. The `t` partial decryptions are combined (Lagrange interpolation over the
   shares) to recover the plaintext. Forge's servers only ever see
   ciphertexts and, if it's even a participant, one partial decryption share
   — never the reconstructed secret key.

## Why this stays out of `native/src/lib.rs` for now
- The noise-flooding magnitude must be calibrated against tfhe-rs's specific
  LWE parameter set (`PARAM_MESSAGE_2_CARRY_2_KS_PBS` or whichever is chosen)
  to guarantee statistical security — this is a parameter-selection exercise
  that needs cryptographic sign-off, not a default I should pick for you.
  the wrong constant here is a silent, invisible vulnerability.
  - The distributed key-generation ceremony (step 1) needs an authenticated
  transport between tenant nodes with protection against a dishonest
  majority, or a trusted setup — a protocol decision with real
  consequences for who Forge's threat model actually protects against.

## Recommended path
1. Ship the real single-key TFHE core (this repo) first — it already gives
   you "Forge cannot decrypt tenant telemetry" for the common case of a
   single tenant-held key.
2. If multi-party threshold trust is a genuine product requirement (e.g. a
   consortium of tenants jointly authorizing decryption), engage a
   cryptography engineer or firm to implement and audit steps 1–4 above
   before it touches production data. This is exactly the kind of primitive
   where "it compiled and the tests passed" is not sufficient evidence of
   security.
