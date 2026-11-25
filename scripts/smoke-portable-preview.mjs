import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const bundle = process.argv[2] ? path.resolve(process.argv[2]) : null;
const windows = process.platform === "win32";
const managementFile = bundle && path.join(bundle, "data-library-settings.json");
if (managementFile) await assert.rejects(readFile(managementFile), { code: "ENOENT" }, "请使用新解压的候选包进行冒烟");
const dataRoot = await mkdtemp(path.join(tmpdir(), "票据簿 临时测试-"));
let child;
let recoveryWorkspace;

async function start() {
  const command = !bundle ? process.execPath : windows ? "cmd.exe" : path.join(bundle, "Start-Receipt-Desk.command");
  const args = !bundle ? ["dist/server/standalone.js", "--no-browser"]
    : windows ? ["/d", "/c", "Start-Receipt-Desk.cmd", "--no-browser"] : ["--no-browser"];
  const env = { ...process.env, RECEIPT_DATA_ROOT: dataRoot };
  if (bundle) delete env.RECEIPT_PYTHON_BIN;
  const processHandle = spawn(command, args, {
    ...(bundle ? { cwd: bundle } : {}),
    env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  child = processHandle;
  let output = "";
  const entry = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("票据簿启动超时")), 15_000);
    processHandle.once("error", (error) => { clearTimeout(timeout); reject(error); });
    processHandle.once("exit", (code, signal) => { clearTimeout(timeout); reject(new Error(`服务退出：${code ?? signal}`)); });
    processHandle.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const url = output.match(/http:\/\/127\.0\.0\.1:\d+\/start\?session=[a-f0-9]{64}/);
      if (!url) return;
      clearTimeout(timeout);
      resolve(new URL(url[0]));
    });
  });
  const start = await fetch(entry, { redirect: "manual" });
  assert.equal(start.status, 303);
  const cookie = start.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const request = (url, options = {}) => fetch(new URL(url, entry), {
    ...options,
    headers: { Cookie: cookie, ...options.headers },
  });
  return { entry, origin: entry.origin, request };
}

async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  if (bundle && windows) {
    const killTree = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    const [code] = await once(killTree, "exit");
    if (code !== 0 && child.exitCode === null) throw new Error("无法停止 Windows 测试服务");
  } else child.kill();
  await exited;
}

try {
  const first = await start();
  if (bundle) {
    assert.equal((await fetch(first.origin + "/api/data-library")).status, 401);
    assert.equal((await first.request("/api/data-library", { headers: { Origin: "http://example.com" } })).status, 403);
  }
  assert.equal((await fetch(first.origin + "/api/materials")).status, 401);
  assert.equal((await fetch(first.origin + "/api/diagnostics")).status, 401);
  assert.equal((await first.request("/api/materials", { headers: { Origin: "http://example.com" } })).status, 403);
  const html = await first.request("/");
  assert.equal(html.status, 200);
  const page = await html.text();
  assert.match(page, /票据簿/);
  const mainScript = page.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  assert.ok(mainScript);
  assert.equal((await first.request(mainScript)).status, 200);
  assert.deepEqual(await (await first.request("/api/materials")).json(), []);
  assert.equal((await first.request("/api/receipt-lines")).status, 404);
  assert.equal((await first.request("/api/log-settings")).status, 404);
  const schoolRuntime = await (await first.request("/api/school-runtime")).json();
  assert.deepEqual(schoolRuntime.missingFiles, []);
  if (process.env.RECEIPT_REQUIRE_SCHOOL_RUNTIME === "1") {
    assert.equal(schoolRuntime.ready, true, JSON.stringify(schoolRuntime));
    assert.equal(schoolRuntime.source, "bundled");
    assert.equal(schoolRuntime.python, "3.12.16");
  }

  const browser = await chromium.launch({
    ...(process.env.RECEIPT_TEST_BROWSER_CHANNEL ? { channel: process.env.RECEIPT_TEST_BROWSER_CHANNEL } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.goto(first.entry.href);
    await page.getByRole("heading", { name: "首次配置", exact: true }).waitFor();
    if (bundle) {
      await page.getByText("选择数据目录或迁移旧库", { exact: true }).click();
      await page.getByLabel("数据操作", { exact: true }).waitFor();
      recoveryWorkspace = await mkdtemp(path.join(tmpdir(), "票据簿 恢复测试-"));
      const selection = path.join(recoveryWorkspace, "拟选目录");
      await page.getByLabel("目标目录", { exact: true }).fill(selection);
      await page.getByRole("button", { name: "安排下次启动执行" }).click();
      await page.getByRole("button", { name: "取消待执行操作" }).click();
      await page.getByRole("button", { name: "保存并开始" }).waitFor();
      await assert.rejects(readdir(selection), { code: "ENOENT" });
      await page.getByText("选择数据目录或迁移旧库", { exact: true }).click();
    }
    await page.getByLabel("姓名", { exact: true }).fill("测试教师");
    await page.getByLabel("学院或部门").fill("示例学院");
    await page.getByLabel("常用投递校区").selectOption("闵行校区");
    await page.getByLabel("协同审批人").fill("00000000/示例审批人");
    await page.getByRole("button", { name: "保存并开始" }).click();
    await page.getByText("还没有进行中的票据集", { exact: true }).waitFor();
    const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const versionLabel = page.getByTitle("应用版本");
    assert.equal(await versionLabel.textContent(), `v${version}`);
    const bounds = await versionLabel.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(bounds && viewport);
    assert.ok(viewport.width - bounds.x - bounds.width < 24);
    assert.ok(viewport.height - bounds.y - bounds.height < 24);
    await page.route("**/api/app-update", (route) => route.fulfill({ json: { status: "development", version } }));
    await versionLabel.click();
    const notes = page.getByRole("dialog", { name: `版本说明 · v${version}` });
    await notes.getByRole("link", { name: "GitHub 公共仓库" }).waitFor();
    await notes.getByRole("button", { name: "检查并更新" }).click();
    await notes.getByRole("status").getByText("开发模式检查完成。没有下载或替换程序文件。").waitFor();
    await notes.getByRole("button", { name: "关闭版本说明" }).click();
    const privateValue = "虚构票据与凭据 fixture-local-secret";
    const operation = await page.evaluate(async (sensitive) => {
      const response = await fetch("/api/auto-classify?fixture=" + encodeURIComponent(sensitive), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ background: true, folder: sensitive }),
      });
      return { status: response.status, id: response.headers.get("X-Receipt-Operation-Id") };
    }, privateValue);
    assert.equal(operation.status, 202);
    assert.ok(operation.id);
    await page.getByRole("button", { name: "系统设置" }).click();
    const settings = page.getByRole("dialog", { name: "系统设置" });
    const preview = settings.getByLabel("诊断内容预览");
    await preview.waitFor();
    assert.equal(await settings.getByLabel("最低日志等级").count(), 0);
    const previewText = await preview.inputValue();
    const { events } = JSON.parse(previewText);
    const related = events.filter((event) => event.operationId === operation.id);
    assert.ok(related.some((event) => event.source === "browser" && event.status === 202));
    assert.ok(related.some((event) => event.source === "server" && event.status === 202));
    assert.ok(related.some((event) => event.source === "server" && event.event === "failed"));
    for (const value of ["fixture-local-secret", "测试教师", "示例学院", JSON.stringify(dataRoot).slice(1, -1)]) {
      assert.ok(!previewText.includes(value));
    }
    const download = page.waitForEvent("download");
    await settings.getByRole("button", { name: "下载诊断 JSON" }).click();
    assert.equal(await readFile(await (await download).path(), "utf8"), previewText + "\n");
    await settings.getByRole("button", { name: "关闭系统设置" }).click();
    await page.getByRole("button", { name: "新建票据集", exact: true }).click();
    await page.getByRole("heading", { name: "新建票据集", exact: true }).waitFor();
  } finally {
    await browser.close();
  }


  if (windows && bundle) {
    const fixtureSecret = "synthetic-test-password-" + "密钥";
    const fixtureAccount = "windows-test-account";
    const fixtureApiKey = "synthetic-test-api";
    const post = (url, body) => first.request(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const model = await (await first.request("/api/user-profiles")).json();
    const profile = model.profiles[0];
    profile.profile.schoolSsoAccount = fixtureAccount;
    assert.equal((await post("/api/user-profiles", { profiles: [profile] })).status, 200);
    assert.equal((await post("/api/user-credentials?profileId=profile-default", {
      schoolSsoAccount: fixtureAccount, schoolSsoPassword: fixtureSecret,
    })).status, 200);
    assert.equal((await post("/api/ai-api-key", { apiKey: fixtureApiKey })).status, 200);
    const credentialDir = path.join(dataRoot, ".guanzizai", "credentials");
    const encryptedFiles = await readdir(credentialDir);
    assert.equal(encryptedFiles.length, 2);
    for (const name of encryptedFiles) {
      assert.match(name, /^[a-f0-9]{64}\.dpapi$/);
      const data = await readFile(path.join(credentialDir, name));
      assert.ok(!data.includes(fixtureSecret) && !data.includes(fixtureApiKey) && !data.includes(fixtureAccount));
    }
    const status = await (await first.request("/api/user-credential-status?profileId=profile-default")).json();
    assert.equal(status.schoolSsoConfigured, true);
    const runtime = path.join(bundle, "runtime", "python");
    const checkPython = (scenario) => execFileSync(path.join(runtime, "python.exe"), [
      "-c", [
        "import sys",
        "sys.path.insert(0, sys.argv[1])",
        "from receipt_runtime import windows_school_credentials, school_session",
        "if sys.argv[2] == 'read':",
        "    assert windows_school_credentials() == tuple(sys.argv[3:])",
        "    assert school_session('treasury') != school_session('elab')",
        "else:",
        "    try: school_session('treasury')",
        "    except RuntimeError: pass",
        "    else: raise AssertionError('unsafe profile accepted')",
      ].join("\n"), path.join(bundle, "app", "tools"), scenario, fixtureAccount, fixtureSecret,
    ], { env: { ...process.env, RECEIPT_DATA_ROOT: dataRoot, PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: path.join(runtime, "site-packages"), PYTHONNOUSERSITE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    checkPython("read");
    profile.profile.schoolSsoAccount = "different-account";
    assert.equal((await post("/api/user-profiles", { profiles: [profile] })).status, 200);
    checkPython("mismatch");
    profile.profile.schoolSsoAccount = fixtureAccount;
    const secondProfile = { ...profile, id: "user-other", profile: { ...profile.profile, schoolSsoAccount: "other-account" } };
    assert.equal((await post("/api/user-credentials?profileId=user-other", {
      schoolSsoAccount: "other-account", schoolSsoPassword: fixtureSecret,
    })).status, 200);
    assert.equal((await post("/api/user-profiles", { profiles: [profile, secondProfile] })).status, 200);
    checkPython("multiple");
    assert.equal((await post("/api/user-profiles", { profiles: [profile] })).status, 200);
  }

  const fixture = "虚构测试票据\n总额 CNY 12.00";
  const uploaded = await first.request("/api/import?filename=" + encodeURIComponent("示例 票据.txt"), {
    method: "POST", body: fixture,
  });
  assert.equal(uploaded.status, 201);
  const material = (await uploaded.json()).path;
  assert.equal(await readFile(path.join(dataRoot, material), "utf8"), fixture);
  assert.equal(await (await first.request("/materials/" + encodeURIComponent(material))).text(), fixture);

  if (bundle && process.env.RECEIPT_REQUIRE_SCHOOL_RUNTIME === "1") {
    const archive = await first.request("/api/download-selected", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths: [material] }),
    });
    assert.equal(archive.status, 200);
    assert.equal(archive.headers.get("content-type"), "application/zip");
    const zip = Buffer.from(await archive.arrayBuffer());
    assert.equal(zip.subarray(0, 4).toString("hex"), "504b0304");
    assert.ok(zip.includes(Buffer.from(path.posix.basename(material))), "ZIP 应保留中文文件名");
  }

  let printFixture;
  if (windows && bundle) {
    const printers = await first.request("/api/printers");
    assert.equal(printers.status, 200, await printers.clone().text());
    assert.equal((await printers.json()).platform, "win32");
    const fixtureRoot = path.join(dataRoot, "fixture");
    await mkdir(fixtureRoot);
    const python = path.join(bundle, "runtime", "python", "python.exe");
    const pdf = path.join(fixtureRoot, "示例 预览.pdf");
    const docx = path.join(fixtureRoot, "示例 文档.docx");
    execFileSync(python, ["-c", [
      "import sys, zipfile",
      "from pypdf import PdfWriter",
      "w = PdfWriter()",
      "w.add_blank_page(width=420, height=595)",
      "w.add_blank_page(width=595, height=420)",
      "w.write(sys.argv[1])",
      "with zipfile.ZipFile(sys.argv[2], 'w') as z:",
      "    z.writestr('word/document.xml', '<document><p><t>虚构文档预览</t></p></document>')",
    ].join("\n"), pdf, docx], { env: {
      ...process.env, PYTHONPATH: path.join(bundle, "runtime", "python", "site-packages"), PYTHONDONTWRITEBYTECODE: "1",
    }});
    const upload = async (source) => {
      const response = await first.request("/api/import?filename=" + encodeURIComponent(path.basename(source)), {
        method: "POST", body: await readFile(source),
      });
      assert.equal(response.status, 201, await response.clone().text());
      return (await response.json()).path;
    };
    const pdfPath = await upload(pdf);
    const pdfImage = await first.request("/api/preview?path=" + encodeURIComponent(pdfPath));
    assert.equal(pdfImage.status, 200, await pdfImage.clone().text());
    assert.equal(pdfImage.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await pdfImage.arrayBuffer()).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    const office = await first.request("/api/preview?path=" + encodeURIComponent(await upload(docx)));
    assert.equal(office.status, 200);
    assert.match(await office.text(), /虚构文档预览/);

    // Exercise the native print-page callback without sending a job to a physical printer.
    const runWindowsMaterials = (args) => execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      path.join(bundle, "app", "tools", "windows-materials.ps1"), ...args,
    ], { encoding: "utf8", windowsHide: true, timeout: 40_000 });
    const virtual = JSON.parse(runWindowsMaterials(["-Operation", "printers"]))
      .find((printer) => printer.virtual && printer.name === "Microsoft Print to PDF");
    if (virtual) {
      const output = path.join(fixtureRoot, "虚拟打印.pdf");
      runWindowsMaterials(["-Operation", "print", "-Printer", virtual.name, "-Source", pdf,
        "-JobName", "Receipt smoke test", "-Output", output]);
      const waitForOutput = async () => {
        for (let attempt = 0; attempt < 30; attempt++) {
          const bytes = await readFile(output).catch(() => Buffer.alloc(0));
          if (bytes.includes(Buffer.from("%%EOF"))) return bytes;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        throw new Error("虚拟打印机未生成完整 PDF");
      };
      assert.match((await waitForOutput()).subarray(0, 8).toString("ascii"), /^%PDF-/);
      const pageCount = execFileSync(python, ["-c", "import sys; from pypdf import PdfReader; print(len(PdfReader(sys.argv[1]).pages))", output], { encoding: "utf8", env: {
        ...process.env, PYTHONPATH: path.join(bundle, "runtime", "python", "site-packages"), PYTHONDONTWRITEBYTECODE: "1",
      }});
      assert.equal(pageCount.trim(), "2");
      console.log("Windows 原生打印已输出两页合成 PDF");
    } else console.log("Runner 无 Microsoft Print to PDF 驱动，跳过虚拟出纸检查");

    // Confirming a queued job writes the existing content-hash record after service restart.
    printFixture = { path: pdfPath, hash: createHash("sha256").update(await readFile(pdf)).digest("hex"), date: "2026-01-15" };
    await writeFile(path.join(dataRoot, ".guanzizai", "print-pending.json"), JSON.stringify({
      [printFixture.hash]: { date: printFixture.date },
    }));
  }

  await stop();
  const second = await start();
  if (printFixture) {
    const before = await (await second.request("/api/print-log")).json();
    assert.deepEqual(before.unconfirmedHashes, [printFixture.hash]);
    assert.equal(before.entries[printFixture.hash], undefined);
    const original = path.join(dataRoot, printFixture.path);
    const renamed = printFixture.path.replace(/[^/]+$/, "改名后.pdf");
    await writeFile(path.join(dataRoot, renamed), await readFile(original));
    const confirmed = await second.request("/api/print-confirm", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [renamed], printed: true }),
    });
    assert.equal(confirmed.status, 200);
    const result = await confirmed.json();
    assert.deepEqual(result.unconfirmedHashes, []);
    assert.equal(result.entries[printFixture.hash], printFixture.date);
  }
  const setup = await (await second.request("/api/first-run")).json();
  assert.equal(setup.completed, true);
  const secondSetup = await second.request("/api/first-run", { method: "PUT", body: JSON.stringify({ campus: "普陀校区" }) });
  assert.equal((await secondSetup.json()).delivery.campus, "闵行校区");
  assert.deepEqual(setup.delivery, { campus: "闵行校区", approver: "00000000/示例审批人", printByFinance: false });
  const profiles = (await (await second.request("/api/user-profiles")).json()).profiles;
  assert.equal(profiles[0].profile.chineseName, "测试教师");
  assert.equal(profiles[0].profile.organization, "示例学院");
  if (windows && bundle) {
    const status = await (await second.request("/api/user-credential-status?profileId=profile-default")).json();
    assert.equal(status.schoolSsoConfigured, true);
    const treasury = await (await second.request("/api/treasury-status")).json();
    assert.equal(treasury.state, "stale");
  }
  const files = await (await second.request("/api/materials")).json();
  assert.ok(files.some((file) => file.path === material), "重启后应找到导入文件");
  // Split a synthetic cloud expense carrying a node-classified fee schedule without an expense link.
  const folder = "01_报销材料/10_办理中/2026/示例票据集";
  const attachment = `${folder}/示例费用清单.txt`;
  const metadataPath = path.join(dataRoot, "data", "receipt-meta.json");
  await mkdir(path.join(dataRoot, folder), { recursive: true });
  await writeFile(path.join(dataRoot, attachment), fixture);
  const meta = { metadata: { [attachment]: { classifiedWorkflowNodeId: "cloud-fee-schedule" } } };
  await writeFile(metadataPath, JSON.stringify(meta));
  const sourceLineId = "split-smoke-source";
  const expenseId = "split-smoke-expense";
  const evidenceId = "split-smoke-evidence";
  const send = (url, method, body) => second.request(url, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const saved = await send("/api/model-state", "PUT", {
    sets: [{ id: sourceLineId, kind: "日常", title: "示例票据集", folder, status: "active" }],
    expenses: [{ id: expenseId, setId: sourceLineId, typeId: "cloud-service", currency: "CNY", amountCny: 12, status: "identified" }],
    evidence: [{ id: evidenceId, path: attachment, typeId: "fee-schedule", extracted: {} }],
    links: [],
  });
  assert.equal(saved.status, 200);
  const response = await send("/api/split-line", "POST", { sourceLineId, expenseIds: [expenseId] });
  const split = await response.json();
  assert.equal(response.status, 200, JSON.stringify(split));
  assert.equal(split.moved, 1, JSON.stringify(split));
  const newPath = `${split.folder}/示例费用清单.txt`;
  assert.equal(await readFile(path.join(dataRoot, newPath), "utf8"), fixture);
  await assert.rejects(readFile(path.join(dataRoot, attachment)), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(metadataPath, "utf8")).metadata, { [newPath]: meta.metadata[attachment] });

  if (bundle) {
    const legacyFolder = "01_报销材料/90_已归档/2026/恢复后的示例票据";
    const receipt = `${legacyFolder}/虚构原件.txt`;
    await mkdir(path.join(dataRoot, legacyFolder), { recursive: true });
    await writeFile(path.join(dataRoot, receipt), fixture);
    // A former app may have persisted only its model, without a receipt-lines mirror.
    const legacyOverride = { "recovery-line:fixture": true };
    const legacyBatch = { id: "recovery-batch", title: "合成批次", status: "draft", receiptPaths: [receipt] };
    await writeFile(path.join(dataRoot, "data", "reimbursement-model.json"), JSON.stringify({
      schemaVersion: 2, migrated: true,
      sets: [{ id: "recovery-line", title: "恢复后的示例票据", status: "archived", kind: "日常",
        folder: legacyFolder, createdAt: "2026-01-01", archivedAt: "2026-01-15T01:00:00.000Z",
        requirements: [], attachments: [], notes: [] }],
      evidence: [], expenses: [], links: [], exchangeRates: [],
      batches: [legacyBatch], requirementOverrides: legacyOverride,
    }));
    await rm(path.join(dataRoot, "data", "receipt-lines.json"), { force: true });
    assert.ok(recoveryWorkspace);
    const backup = path.join(recoveryWorkspace, "示例备份");
    const restored = path.join(recoveryWorkspace, "恢复的新库");
    const schedule = (app, body) => app.request("/api/data-library", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const queuedBackup = await schedule(second, { action: "backup", destination: backup });
    assert.equal(queuedBackup.status, 200, await queuedBackup.clone().text());
    assert.equal((await queuedBackup.json()).pending.action, "backup");
    await assert.rejects(readFile(path.join(backup, newPath)), { code: "ENOENT" });
    await stop();
    const afterBackup = await start();
    assert.equal(await readFile(path.join(backup, newPath), "utf8"), fixture);
    const queuedRestore = await schedule(afterBackup, { action: "restore", source: backup, destination: restored });
    assert.equal(queuedRestore.status, 200, await queuedRestore.clone().text());
    await stop();
    const afterRestore = await start();
    const restoredStatus = await (await afterRestore.request("/api/data-library")).json();
    assert.equal(restoredStatus.active, await realpath(restored));
    assert.equal(restoredStatus.last.status, "completed");
    assert.equal((await (await afterRestore.request("/api/first-run")).json()).completed, true);
    assert.equal(await (await afterRestore.request("/materials/" + encodeURIComponent(newPath))).text(), fixture);
    assert.equal(await readFile(path.join(dataRoot, newPath), "utf8"), fixture);
    const restoredBrowser = await chromium.launch({
      ...(process.env.RECEIPT_TEST_BROWSER_CHANNEL ? { channel: process.env.RECEIPT_TEST_BROWSER_CHANNEL } : {}),
    });
    try {
      const page = await restoredBrowser.newPage();
      await page.goto(afterRestore.entry.href);
      await page.getByRole("navigation", { name: "报销状态" }).getByRole("button", { name: /已归档/ }).click();
      await page.getByText("恢复后的示例票据", { exact: true }).waitFor();
      const { model } = await (await afterRestore.request("/api/model-state")).json();
      assert.deepEqual(model.batches, [legacyBatch]);
      assert.deepEqual(model.requirementOverrides, legacyOverride);
      assert.equal(model.sets.find((line) => line.id === "recovery-line").archivedAt, "2026-01-15T01:00:00.000Z");
    } finally { await restoredBrowser.close(); }
    console.log("解包版数据备份、恢复与旧库冷启动通过");
  }

  console.log("独立服务冒烟通过");
} finally {
  await stop();
  await rm(dataRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  if (recoveryWorkspace) await rm(recoveryWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  if (managementFile) await rm(managementFile, { force: true });
}
