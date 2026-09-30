import { writeDemoData } from "./demo-data";
import { queryModelStudy, type ModelStudyQuery } from "./model-study";
import { buildSnapshot } from "./report";
import { queryRequests, type RequestQuery } from "./request-log";

/**
 * 新手引导的演示进程（Electron utilityProcess，见 src/main/demo.ts）。
 *
 * 启动时环境变量已经指向临时目录：TOKENPULSE_DATA_DIR = 演示数据，HOME / USERPROFILE = 空的假主目录。
 * 所以这里读到的 CLI 登录、CC Switch、会话都是空的，用户真实的 ~/.tokenpulse、~/.claude 碰都碰不到。
 * 只算快照、模型换算、请求流水三样；不扫描、不写任何东西（演示数据在第一条消息前生成一次）。
 */
type Message = { id: number; op: "snapshot" | "study" | "requests"; query?: unknown };
const port = (process as unknown as { parentPort: { on(event: "message", fn: (e: { data: Message }) => void): void; postMessage(value: unknown): void } }).parentPort;

writeDemoData(process.env.TOKENPULSE_DATA_DIR!);
// 引导被放着不管：15 分钟没有请求就自己退出，主进程下次要用再起一个
let idle = setTimeout(() => process.exit(0), 15 * 60000);

port.on("message", ({ data }) => {
  clearTimeout(idle);
  idle = setTimeout(() => process.exit(0), 15 * 60000);
  try {
    let result: unknown;
    if (data.op === "snapshot") {
      const snapshot = buildSnapshot() as ReturnType<typeof buildSnapshot> & { demo?: boolean };
      snapshot.requestFlags = { flagged: 0, mismatch: 0, suspect: 0 };
      snapshot.demo = true;
      result = snapshot;
    } else if (data.op === "study") result = queryModelStudy(data.query as ModelStudyQuery);
    else if (data.op === "requests") result = queryRequests(data.query as RequestQuery);
    else throw new Error("未知的演示请求");
    port.postMessage({ id: data.id, result });
  } catch (error) {
    port.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  }
});
