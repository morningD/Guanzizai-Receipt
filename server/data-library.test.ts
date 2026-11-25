import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPendingDataOperation, lockDataDirectory, prepareDataOperation, readDataSettings } from "../scripts/portable/data-library.mjs";

let root: string;
let install: string;
let active: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "票据簿 数据测试-"));
  install = path.join(root, "程序");
  active = path.join(root, "活动库");
  await mkdir(install);
  await mkdir(path.join(active, "01_报销材料"), { recursive: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function put(base: string, file: string, content: unknown) {
  const full = path.join(base, file);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, typeof content === "string" ? content : JSON.stringify(content));
}

describe("本机数据管理", () => {
  it("迁移保留材料、经费关联、归档时间及签名，并规范库内绝对路径", async () => {
    const source = path.join(root, "旧库");
    const target = path.join(root, "新库");
    const receipt = "01_报销材料/90_已归档/示例/发票.pdf";
    const sourceFile = path.join(source, receipt);
    await put(source, receipt, "虚构原件");
    await put(source, "data/reimbursement-model.json", {
      sets: [{ id: "set", folder: path.dirname(sourceFile), archivedAt: "2026-02-01T00:00:00Z" }],
      expenses: [{ id: "expense", setId: "set" }],
      evidence: [{ id: "proof", path: sourceFile }, { id: "win-proof", path: "C:/Old/" + receipt.replaceAll("/", "\\") }],
      links: [{ evidenceId: "proof", expenseId: "expense" }],
    });
    await put(source, "data/receipt-meta.json", { metadata: { [sourceFile]: { paid: true } } });
    await put(source, ".guanzizai/user-profiles/profile-default/signature.png", "虚构签名");
    await put(source, ".guanzizai/user-profiles/profile-default/school/session.json", "不应复制");
    await put(source, ".guanzizai/credentials/hidden.dpapi", "不应复制");
    await put(source, "data/df/session.json", "不应复制");
    const pending = await prepareDataOperation({ action: "migrate", source, destination: target }, active, install);
    const migrated = await applyPendingDataOperation(install, { pending }, active);
    expect(migrated).toBe(await realpath(target));
    const model = JSON.parse(await readFile(path.join(target, "data/reimbursement-model.json"), "utf8"));
    expect(model.evidence.map((item: { path: string }) => item.path)).toEqual([receipt, receipt]);
    expect(model.sets[0]).toEqual({ id: "set", folder: "01_报销材料/90_已归档/示例", archivedAt: "2026-02-01T00:00:00Z" });
    expect(model.links).toEqual([{ evidenceId: "proof", expenseId: "expense" }]);
    expect(JSON.parse(await readFile(path.join(target, "data/receipt-meta.json"), "utf8")).metadata).toEqual({ [receipt]: { paid: true } });
    expect(await readFile(sourceFile, "utf8")).toBe("虚构原件");
    expect(await readFile(path.join(target, receipt), "utf8")).toBe("虚构原件");
    expect(await readFile(path.join(target, ".guanzizai/user-profiles/profile-default/signature.png"), "utf8")).toBe("虚构签名");
    for (const path_ of [".guanzizai/user-profiles/profile-default/school", ".guanzizai/credentials", "data/df/session.json"]) {
      await expect(stat(path.join(target, path_))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("备份恢复校验哈希，失败时保留当前库，成功后使用新目录", async () => {
    const filename = "01_报销材料/发票.txt";
    await put(active, filename, "虚构票据");
    const backup = path.join(root, "备份");
    const pending = await prepareDataOperation({ action: "backup", destination: backup }, active, install);
    expect(await applyPendingDataOperation(install, { pending }, active)).toBe(active);
    const restored = path.join(root, "恢复");
    const restore = await prepareDataOperation({ action: "restore", source: backup, destination: restored }, active, install);
    await put(backup, filename, "虚构篡改");
    expect(await applyPendingDataOperation(install, { pending: restore }, active)).toBe(active);
    expect((await readDataSettings(install)).last).toMatchObject({ status: "failed", error: expect.stringContaining("校验失败") });
    await expect(stat(restored)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(active, filename), "utf8")).toBe("虚构票据");
    await put(backup, filename, "虚构票据");
    expect(await applyPendingDataOperation(install, { pending: restore }, active)).toBe(await realpath(restored));
    expect(await readFile(path.join(restored, filename), "utf8")).toBe("虚构票据");
    expect((await readDataSettings(install)).directory).toBe(await realpath(restored));
  });

  it("拒绝程序目录、已有的备份目标及并发使用同一数据目录", async () => {
    await expect(prepareDataOperation({ action: "use", destination: path.join(install, "库") }, active, install)).rejects.toThrow("重叠");
    const existing = path.join(root, "已有");
    await mkdir(existing);
    await expect(prepareDataOperation({ action: "backup", destination: existing }, active, install)).rejects.toThrow("新目录");
    const unlock = await lockDataDirectory(active);
    try { await expect(lockDataDirectory(active)).rejects.toThrow("正在使用"); }
    finally { unlock(); }
  });

  it("识别中断留下的半库，并复验同一任务已经写出的备份", async () => {
    const half = path.join(root, "半库");
    await put(half, ".receipt-copying", "old");
    await put(half, "01_报销材料/发票.txt", "半成品");
    await expect(prepareDataOperation({ action: "use", destination: half }, active, install)).rejects.toThrow("尚未完成");
    await expect(prepareDataOperation({ action: "migrate", source: half, destination: path.join(root, "新库") }, active, install)).rejects.toThrow("尚未完成");

    const backup = path.join(root, "备份");
    await put(active, "01_报销材料/发票.txt", "原件");
    const pending = await prepareDataOperation({ action: "backup", destination: backup }, active, install);
    await applyPendingDataOperation(install, { pending }, active);
    await put(backup, "01_报销材料/发票.txt", "修改");
    await applyPendingDataOperation(install, { pending }, active);
    expect((await readDataSettings(install)).last).toMatchObject({ status: "failed", error: expect.stringContaining("校验失败") });
    expect(await readFile(path.join(active, "01_报销材料/发票.txt"), "utf8")).toBe("原件");
  });

  it.skipIf(process.platform === "win32")("复制库内文件引用并拒绝库外链接", async () => {
    const file = path.join(active, "01_报销材料", "原件.txt");
    await writeFile(file, "原件");
    await symlink("原件.txt", path.join(active, "01_报销材料", "引用.txt"));
    let pending = await prepareDataOperation({ action: "backup", destination: path.join(root, "备份") }, active, install);
    await applyPendingDataOperation(install, { pending }, active);
    expect(await readFile(path.join(pending.destination, "01_报销材料/引用.txt"), "utf8")).toBe("原件");
    await symlink(path.join(root, "外部.txt"), path.join(active, "01_报销材料", "外部.txt"));
    await put(root, "外部.txt", "不应复制");
    pending = await prepareDataOperation({ action: "backup", destination: path.join(root, "第二份") }, active, install);
    await applyPendingDataOperation(install, { pending }, active);
    expect((await readDataSettings(install)).last?.status).toBe("failed");
    await expect(stat(pending.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
