import { authErrorResponse, requireRole } from "@/infra/auth/guard";
import { ROLES } from "@/infra/auth/session";

export async function GET() {
  try {
    const s = await requireRole(...ROLES);
    return Response.json({ role: s.role, sub: s.sub });
  } catch (err) {
    return authErrorResponse(err);
  }
}
