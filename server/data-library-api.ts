import type { IncomingMessage, ServerResponse } from "node:http";
import { prepareDataOperation, readDataSettings, saveDataSettings } from "../scripts/portable/data-library.mjs";

export function createDataLibraryApi(install: string, active: string) {
  let writes = Promise.resolve();
  function send(response: ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(body));
  }
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (request.method === "GET") {
        await writes;
        const settings = await readDataSettings(install);
        send(response, 200, { active, pending: settings.pending, last: settings.last });
        return;
      }
      if (request.method !== "POST") {
        send(response, 405, { error: "不支持该请求" });
        return;
      }
      let raw = "";
      request.setEncoding("utf8");
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 16_384) {
          send(response, 413, { error: "目录信息过长" });
          return;
        }
      }
      const input = JSON.parse(raw);
      const change = writes.then(async () => {
        const settings = await readDataSettings(install);
        if (input?.action === "cancel") {
          await saveDataSettings(install, { directory: settings.directory, last: settings.last });
          return { active, last: settings.last };
        }
        if (settings.pending) throw new Error("已有待执行的数据操作，请先取消或重启应用");
        const pending = await prepareDataOperation(input, active, install);
        await saveDataSettings(install, { ...settings, pending });
        return { active, pending, last: settings.last };
      });
      writes = change.then(() => undefined, () => undefined);
      send(response, 200, await change);
    } catch (error) {
      send(response, 400, { error: error instanceof Error ? error.message : "无法处理数据目录" });
    }
  };
}
