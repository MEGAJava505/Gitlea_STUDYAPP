import { getOidcLoginServices, oidcUnavailable } from '../../../../../server/oidc-login-services';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(req: Request): Promise<Response> {
  try { return await getOidcLoginServices().callback(req); }
  catch { return oidcUnavailable(); }
}
