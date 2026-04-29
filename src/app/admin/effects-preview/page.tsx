import { EFFECT_TAGS } from "~/lib/panel-tags";
import { EffectsPreviewClient } from "./EffectsPreviewClient";

export const dynamic = "force-dynamic";

export default function EffectsPreviewPage() {
  return (
    <main className="min-h-screen bg-neutral-950 px-6 py-8 text-neutral-100">
      <div className="mx-auto max-w-6xl">
        <h1 className="mb-2 text-2xl font-semibold">Effects preview</h1>
        <p className="mb-6 text-sm text-neutral-400">
          Each tag rendered over a sample panel rect. Implemented effects
          animate; unmapped tags render nothing (and the card is greyed).
        </p>
        <EffectsPreviewClient tags={[...EFFECT_TAGS]} />
      </div>
    </main>
  );
}
