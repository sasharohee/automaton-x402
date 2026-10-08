import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, dashboardPassword, verifySessionValue } from "@/lib/session";
import ConfigError from "./ConfigError";
import Dashboard from "./Dashboard";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!dashboardPassword()) return <ConfigError />;
  const jar = await cookies();
  if (!(await verifySessionValue(jar.get(SESSION_COOKIE)?.value))) redirect("/login");
  return <Dashboard />;
}
