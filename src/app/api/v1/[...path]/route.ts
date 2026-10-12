import { handle } from "@/interfaces/http/handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Own-photo image editing is bounded at210s; deployment hosts must support this request duration.
export const maxDuration = 240;
type Context = { params: Promise<{ path: string[] }> };
async function route(request: Request, context: Context) {
  return handle(request, (await context.params).path);
}
export {
  route as GET,
  route as POST,
  route as PUT,
  route as PATCH,
  route as DELETE,
};
