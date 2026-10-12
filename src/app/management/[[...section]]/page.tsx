import { Management } from "@/ui/management";
export default async function ManagementPage({
  params,
}: {
  params: Promise<{ section?: string[] }>;
}) {
  const { section } = await params;
  return <Management section={section?.[0] || "overview"} />;
}
