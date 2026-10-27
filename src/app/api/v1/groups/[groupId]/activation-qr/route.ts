import { activationRoute } from '@/server/activation-services';
export const runtime='nodejs';
export async function POST(req:Request,context:{params:Promise<{groupId:string}>}) {const {groupId}=await context.params;return activationRoute(h=>h.issue(req,groupId));}
export async function DELETE(req:Request,context:{params:Promise<{groupId:string}>}) {const {groupId}=await context.params;return activationRoute(h=>h.revoke(req,groupId));}
