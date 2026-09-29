import fs from "node:fs";
import path from "node:path";

// Sổ tay các lệnh đã gửi byte xuống máy in nhưng CHƯA báo được kết quả về hàng
// đợi. Mất mạng sau khi tem đã ra giấy thì lệnh kẹt ở "spooling"; hết lease,
// backend trả lệnh về "queued" và agent nhận lại — sổ tay này là thứ duy nhất
// ngăn agent in lần hai. Đặt trong temp/ vì install-agent.ps1 giữ nguyên thư
// mục này khi nâng cấp.
//
// stage: "sending" (bắt đầu gửi) → "sent" (spooler đã nhận) → "printed" (có
// result) hoặc "failed" (có error). Báo được kết quả thì xoá mục đó đi.
const KEEP_MS = 7 * 24 * 3600 * 1000;

export function createSentJournal(dir, { logger, now = () => Date.now() } = {}) {
  const file = path.join(dir, "sent-jobs.json");
  const load = () => {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch (error) {
      if (error?.code !== "ENOENT") logger?.warn(`Không đọc được ${file}: ${error.message}`);
      return {};
    }
  };
  const save = (entries) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const temporary = `${file}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(entries, null, 1), "utf8");
      fs.renameSync(temporary, file);
    } catch (error) {
      // Mất sổ tay chỉ mất lớp chống in trùng, không được chặn đường in.
      logger?.error(`Không ghi được ${file}: ${error.message}`);
    }
  };
  const prune = (entries) => {
    for (const [jobId, entry] of Object.entries(entries)) {
      if (!(now() - Date.parse(entry?.updatedAt) < KEEP_MS)) delete entries[jobId];
    }
    return entries;
  };
  return {
    file,
    get(jobId) {
      return load()[jobId] ?? null;
    },
    record(jobId, fields) {
      const entries = prune(load());
      entries[jobId] = { ...entries[jobId], ...fields, updatedAt: new Date(now()).toISOString() };
      save(entries);
    },
    remove(jobId) {
      const entries = load();
      if (!(jobId in entries)) return;
      delete entries[jobId];
      save(prune(entries));
    }
  };
}
