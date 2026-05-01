import { getVoices } from "./actions";
import { VoicesClient } from "./VoicesClient";

export const dynamic = "force-dynamic";

export default async function VoicesPage() {
  const voices = await getVoices();

  return (
    <main className="min-h-screen bg-neutral-950 px-6 py-8 text-neutral-100">
      <div className="mx-auto max-w-5xl">
        <h1 className="mb-6 text-2xl font-bold">Voice Rotation</h1>
        <VoicesClient voices={voices} />
      </div>
    </main>
  );
}
