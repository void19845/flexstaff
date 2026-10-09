import type { Metadata } from "next";
import { RewardsApp } from "@/components/rewards-app";

export const metadata: Metadata = {
  title: "Flexstaff · Récompenses",
  robots: { index: false, follow: false },
};

export default function StaffPage() {
  return (
    <main className="page-staff">
      <RewardsApp />
    </main>
  );
}
