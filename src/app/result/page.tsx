import type { Metadata } from "next";
import { SavedBeautyResultView } from "@/ui/saved-beauty-result";

export const metadata: Metadata = {
  title: "Your saved beauty guide · AELUNE",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function ResultPage() {
  return <SavedBeautyResultView />;
}
