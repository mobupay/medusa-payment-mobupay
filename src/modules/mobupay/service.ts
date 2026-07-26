// Mobupay — fournisseur de paiement Medusa v2 (offsite redirect). PLAN-210 Phase C.
// Consomme l'API publique Mobupay (création de session, remboursement, webhook signé V2).
// Medusa tourne sous Node -> on vérifie la signature V2 avec le module `crypto` natif.
// Statut : VALIDÉ e2e sur Medusa 2.17.1 (2026-07-01) — initiatePayment (session + redirect),
// paiement réel capturé, getWebhookActionAndData (signature V2 OK/rejet, mapping captured).
// PLAN-291 lot 3.C (packaging npm) : migration vers l'interface provider 2.x typée
// (InitiatePaymentInput/Output, entrées enveloppées { data }, erreurs par throw) —
// mêmes appels API, même mapping de statuts. Ajouts au passage : la devise est stockée
// dans la session (le refund convertissait tout en EUR), et le `session_id` Medusa est
// transmis comme `externalId` Mobupay (écho dans le webhook -> mapping exact, pattern
// du provider Stripe officiel).

import crypto from "crypto";
import { AbstractPaymentProvider } from "@medusajs/framework/utils";
import type {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  PaymentSessionStatus,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types";

type Options = {
  apiKey: string;            // sk_live_… / sk_test_…
  webhookSecret: string;     // whsec_…
  apiBase?: string;          // défaut https://api.mobupay.nc
  redirectUrl: string;       // page de retour storefront après paiement (côté acheteur)
  // URL PUBLIQUE du backend Medusa (ex. tunnel), pour que Mobupay POSTe le webhook sur
  // la route Medusa /hooks/payment/mobupay_mobupay -> déclenche getWebhookActionAndData.
  webhookBaseUrl: string;
};

// EUR -> centimes, XPF -> unité. Medusa fournit un montant décimal en devise.
function toMinorUnits(amount: number, currency: string): number {
  const factor = currency.toUpperCase() === "XPF" ? 1 : 100;
  return Math.round(Number(amount) * factor);
}

// Inverse : les webhooks Mobupay portent un montant en unité mineure ; Medusa attend
// un montant décimal en devise (comparé aux sessions côté module Payment).
function toDecimalUnits(minor: number, currency: string): number {
  const factor = String(currency).toUpperCase() === "XPF" ? 1 : 100;
  return Number(minor) / factor;
}

// BigNumberInput Medusa = number | string | { value } | BigNumber ({ numeric }).
function bigNumberToNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  if (v && typeof v === "object") {
    const raw = v as { numeric?: number; value?: string | number };
    if (typeof raw.numeric === "number") return raw.numeric;
    if (raw.value !== undefined) return Number(raw.value);
  }
  return Number(v);
}

class MobupayProviderService extends AbstractPaymentProvider<Options> {
  static identifier = "mobupay";

  // Le constructeur de la classe mère est `protected` ; ModuleProvider exige un
  // constructeur public (idem provider Stripe officiel).
  constructor(container: Record<string, unknown>, options: Options) {
    super(container, options);
  }

  static validateOptions(options: Record<string, unknown>): void {
    for (const key of ["apiKey", "webhookSecret", "redirectUrl", "webhookBaseUrl"] as const) {
      if (!options?.[key]) {
        throw new Error(`Mobupay : option "${key}" manquante dans medusa-config.ts`);
      }
    }
  }

  private get base(): string {
    return this.config.apiBase || "https://api.mobupay.nc";
  }

  private async api(path: string, body: unknown, idempotencyKey?: string) {
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Mobupay ${path} failed: ${res.status}`);
    return json as Record<string, any>;
  }

  // Crée une session Mobupay et renvoie l'URL de la page hébergée dans `data.checkoutUrl`
  // (le storefront y redirige l'acheteur). `externalId` = session_id Medusa (écho dans le
  // webhook -> mapping exact) ; l'Idempotency-Key est distincte : elle doit varier quand
  // le montant change (updatePayment), sinon l'API renverrait la première session.
  private async createMobupaySession(args: {
    amount: unknown;
    currency_code: string;
    externalId?: string;
    idempotencyKey?: string;
  }): Promise<InitiatePaymentOutput> {
    const currency = (args.currency_code || "EUR").toUpperCase();
    const amount = toMinorUnits(bigNumberToNumber(args.amount), currency);
    const externalId = args.externalId || `MED-${Date.now()}`;
    const session = await this.api(
      "/api/v1/payments/sessions",
      {
        order: { reference: String(externalId), amount, currency },
        redirectUrl: this.config.redirectUrl,
        // Route webhook Medusa v2 (format {identifier}_{provider}) -> getWebhookActionAndData.
        notificationUrl: `${this.config.webhookBaseUrl.replace(/\/$/, "")}/hooks/payment/mobupay_mobupay`,
        externalId: String(externalId),
      },
      args.idempotencyKey ?? String(externalId),
    );
    return {
      id: String(session.paymentId),
      data: {
        paymentId: session.paymentId,
        checkoutUrl: session.checkoutUrl,
        externalId,
        currency,
      },
    };
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const sessionId = input.data?.session_id ? String(input.data.session_id) : undefined;
    return this.createMobupaySession({
      amount: input.amount,
      currency_code: input.currency_code,
      externalId: sessionId,
      idempotencyKey: sessionId ?? input.context?.idempotency_key,
    });
  }

  // Le montant/panier a changé avant paiement : la page hébergée fige le montant à la
  // création -> on recrée une session Mobupay (l'Idempotency-Key intègre le nouveau
  // montant, l'externalId reste le session_id Medusa pour le mapping webhook).
  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const sessionId = input.data?.session_id ? String(input.data.session_id) : undefined;
    const currency = (input.currency_code || "EUR").toUpperCase();
    const amount = toMinorUnits(bigNumberToNumber(input.amount), currency);
    return this.createMobupaySession({
      amount: input.amount,
      currency_code: input.currency_code,
      externalId: sessionId,
      idempotencyKey: sessionId ? `${sessionId}-${amount}` : undefined,
    });
  }

  // Le paiement est confirmé par webhook ; tant qu'il n'est pas capturé -> pending.
  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const status = await this.fetchStatus(String(input.data?.paymentId ?? ""));
    return { status, data: input.data };
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const status = await this.fetchStatus(String(input.data?.paymentId ?? ""));
    return { status, data: input.data };
  }

  private async fetchStatus(paymentId: string): Promise<PaymentSessionStatus> {
    if (!paymentId) return "pending";
    try {
      const res = await fetch(`${this.base}/api/v1/payments/${encodeURIComponent(paymentId)}`, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
      });
      const p = (await res.json()) as Record<string, any>;
      switch (p.status) {
        case "captured":
        case "transit":
          return "captured";
        case "authorized":
          return "authorized";
        case "cancelled":
        case "failed":
          return "canceled";
        default:
          return "pending";
      }
    } catch {
      return "pending";
    }
  }

  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    // Mobupay capture le cash-in côté serveur ; rien à forcer ici.
    return { data: input.data };
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const paymentId = String(input.data?.paymentId ?? "");
    // Devise stockée à l'initiation (sinon le montant décimal serait converti comme EUR).
    const currency = String(input.data?.currency || "EUR");
    await this.api(`/api/v1/payments/${encodeURIComponent(paymentId)}/refund`, {
      amount: toMinorUnits(bigNumberToNumber(input.amount), currency),
    });
    return { data: input.data };
  }

  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    return { data: input.data };
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    return { data: input.data };
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    return { data: input.data };
  }

  // Webhook Mobupay -> action Medusa. Vérifie la signature V2 (HMAC {ts}.{corps}).
  async getWebhookActionAndData(payload: ProviderWebhookPayload["payload"]): Promise<WebhookActionResult> {
    const raw = (payload.rawData as Buffer | string)?.toString?.("utf8") ?? String(payload.rawData ?? "");
    const headers = (payload.headers || {}) as Record<string, string>;
    const ts = headers["x-mobupay-timestamp"];
    const sig = headers["x-mobupay-signature-v2"];
    const expected = crypto.createHmac("sha256", this.config.webhookSecret).update(`${ts}.${raw}`, "utf8").digest("hex");
    const ok = !!sig && sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!ok) return { action: "not_supported" };

    const evt = (typeof payload.data === "object" ? payload.data : JSON.parse(raw || "{}")) as Record<string, any>;
    const type = evt.type as string;
    // externalId = session_id Medusa transmis à l'initiation (écho Mobupay) ; l'ancien
    // fallback paymentId est conservé pour les paiements créés avant cette version.
    const sessionId = String(evt?.data?.externalId ?? evt?.data?.paymentId ?? "");
    const amount = toDecimalUnits(Number(evt?.data?.amount ?? 0), String(evt?.data?.currency ?? "EUR"));
    if (type === "payment.captured") return { action: "captured", data: { session_id: sessionId, amount } };
    if (type === "payment.authorized") return { action: "authorized", data: { session_id: sessionId, amount } };
    if (type === "payment.failed" || type === "payment.cancelled" || type === "payment.expired") {
      return { action: "failed", data: { session_id: sessionId, amount } };
    }
    return { action: "not_supported" };
  }
}

export default MobupayProviderService;
