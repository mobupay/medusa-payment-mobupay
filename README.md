# Mobupay pour Medusa v2

> Fournisseur de paiement Mobupay pour **Medusa v2**
> (offsite redirect). Consomme l'API publique Mobupay (sessions, remboursement, webhook
> signé V2). Statut : **VALIDÉ e2e sur Medusa 2.17.1** (2026-07-01) — paiement réel capturé
> + webhook signé (signature V2 vérifiée). NB v2 : options via `this.config`.

## Modèle

`AbstractPaymentProvider` (`static identifier = "mobupay"`). `initiatePayment` crée une
session Mobupay et renvoie l'URL de la page hébergée dans `data.checkoutUrl` (le
storefront y redirige l'acheteur). Le statut est confirmé par webhook
(`getWebhookActionAndData`, signature V2 vérifiée via le module Node `crypto`). Refund
total/partiel via `refundPayment`.

## Fichiers

| Fichier | Rôle |
|---|---|
| `src/modules/mobupay/service.ts` | Provider (initiate/authorize/capture/refund/status/webhook) |
| `src/modules/mobupay/index.ts` | `ModuleProvider(Modules.PAYMENT, …)` |

## Installation

### Par npm (recommandé)

```bash
npm install medusa-payment-mobupay
```

Puis déclarer le provider dans `medusa-config.ts` avec
`resolve: "medusa-payment-mobupay"` (voir la config ci-dessous).

### Par copie de fichiers (alternative)

1. Copier `src/modules/mobupay/` dans le projet Medusa.
2. Déclarer le provider dans `medusa-config.ts` avec `resolve: "./src/modules/mobupay"`.

### Configuration

```ts
module.exports = defineConfig({
  modules: [
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "medusa-payment-mobupay", // ou "./src/modules/mobupay" si copie locale
            id: "mobupay",
            options: {
              apiKey: process.env.MOBUPAY_API_KEY,        // sk_live_… / sk_test_…
              webhookSecret: process.env.MOBUPAY_WEBHOOK_SECRET, // whsec_…
              apiBase: "https://api.mobupay.nc",
              redirectUrl: "https://votre-storefront/checkout/return",
              // URL publique du backend Medusa -> route webhook /hooks/payment/mobupay_mobupay
              webhookBaseUrl: process.env.MOBUPAY_WEBHOOK_BASE_URL,
            },
          },
        ],
      },
    },
  ],
});
```

3. Le webhook Mobupay est POSTé sur la route Medusa **`/hooks/payment/mobupay_mobupay`**
   (format `{identifier}_{provider}`), qui déclenche `getWebhookActionAndData`. Le module
   construit automatiquement la `notificationUrl` à partir de `webhookBaseUrl`.

## Packaging npm

Le dossier est packagé pour npm sous le nom **`medusa-payment-mobupay`** :
`npm run build` (tsc -> `dist/`), entrée `dist/modules/mobupay/index.js`. Les keywords
`medusa-v2` + `medusa-plugin-integration` conditionnent le listing automatique sur
l'annuaire medusajs.com/integrations (vetting mensuel core team, seuil ~20
téléchargements). Publication depuis le repo public `mobupay/medusa-payment-mobupay`
(export via `scripts/publish-connector.sh medusa <version>`).
