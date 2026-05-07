import { NextResponse } from 'next/server';
import { getAuthContext } from '@/lib/auth/permissions';

/** GET /api/me — return the current user's role + capabilities. */
export async function GET() {
  const ctx = await getAuthContext();
  if (!ctx) return NextResponse.json({ user: null }, { status: 200 });

  return NextResponse.json({
    user: {
      id: ctx.userId,
      authUserId: ctx.authUserId,
      email: ctx.email,
      fullName: ctx.fullName,
      role: ctx.role,
    },
  });
}
