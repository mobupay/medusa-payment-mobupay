# Changelog — medusa-payment-mobupay

Le versionnage suit [SemVer](https://semver.org/lang/fr/).

## 1.0.0 — 2026-07-23

Première version publiée sur npm (PLAN-291 lot 3.C).

- Fournisseur de paiement Mobupay pour **Medusa v2** (`AbstractPaymentProvider`,
  identifier `mobupay`) : page de paiement hébergée (redirect), statut confirmé par
  **webhook signé V2** (HMAC vérifié via `crypto` natif), remboursement total/partiel.
- Logique validée e2e sur Medusa 2.17.1 (2026-07-01) : session + redirect, paiement
  réel capturé, vérification de signature (acceptation/rejet).
- Packaging npm : build TypeScript (`dist/`), types inclus, peerDependency
  `@medusajs/framework ^2.0.0`, keywords `medusa-v2` + `medusa-plugin-integration`
  (listing automatique sur l'annuaire medusajs.com/integrations).
- Migration vers l'interface provider 2.x typée (entrées enveloppées `{ data }`,
  erreurs par `throw`, `updatePayment` implémenté : recréation de session si le
  montant change avant paiement).
- La devise est stockée dans la session à l'initiation (le remboursement convertit
  le montant décimal dans la bonne devise, XPF facteur 1 / EUR centimes).
- Le `session_id` Medusa est transmis comme `externalId` Mobupay et récupéré dans
  l'écho du webhook (mapping exact session <-> événement, pattern du provider
  Stripe officiel).
