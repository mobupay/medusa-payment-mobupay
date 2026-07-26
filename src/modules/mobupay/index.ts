// Enregistrement du fournisseur de paiement Mobupay pour Medusa v2. PLAN-210 Phase C.
// À référencer dans medusa-config.ts sous le module Payment (voir README).

import { ModuleProvider, Modules } from "@medusajs/framework/utils";
import MobupayProviderService from "./service";

export default ModuleProvider(Modules.PAYMENT, {
  services: [MobupayProviderService],
});
