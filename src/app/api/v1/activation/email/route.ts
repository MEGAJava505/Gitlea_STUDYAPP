import { activationRoute } from '@/server/activation-services';
export const runtime='nodejs';
export async function POST(req:Request){return activationRoute(h=>h.email(req));}
