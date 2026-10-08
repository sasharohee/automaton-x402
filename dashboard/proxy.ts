import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, dashboardPassword, verifySessionValue } from "@/lib/session";

// Protège la page principale et /api/state. /api/ingest a son propre jeton et
// n'est pas concerné. Les routes revérifient la session (défense en profondeur).
export async function proxy(req: NextRequest) {
  // Sans mot de passe configuré, la page affiche elle-même l'erreur de
  // configuration et /api/state répond 503 : rien n'est exposé.
  if (!dashboardPassword()) return NextResponse.next();

  if (await verifySessionValue(req.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.next();
  }
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "non authentifié" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = {
  matcher: ["/", "/api/state"],
};
