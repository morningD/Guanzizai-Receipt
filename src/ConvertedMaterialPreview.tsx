import { useEffect, useState } from "react";

export function ConvertedMaterialPreview({ url, name }: { url: string; name: string }) {
  const [preview, setPreview] = useState<{ kind: "text" | "image" | "error"; value: string }>();
  useEffect(() => {
    let objectUrl: string | undefined;
    const request = new AbortController();
    setPreview(undefined);
    void fetch(url, { signal: request.signal }).then(async (response) => {
      if (!response.ok) throw new Error("预览不可用");
      if (response.headers.get("Content-Type")?.startsWith("text/plain")) {
        const value = await response.text();
        if (!request.signal.aborted) setPreview({ kind: "text", value });
      } else {
        const blob = await response.blob();
        if (request.signal.aborted) return;
        if (blob.type !== "image/png") throw new Error("预览格式无效");
        objectUrl = URL.createObjectURL(blob);
        setPreview({ kind: "image", value: objectUrl });
      }
    }).catch(() => {
      if (!request.signal.aborted) setPreview({ kind: "error", value: "无法生成预览，可打开或下载原文件查看。" });
    });
    return () => {
      request.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);
  if (preview?.kind === "image") return <img src={preview.value} alt={`${name} 预览`} />;
  return <pre className="material-preview-excerpt">{preview?.value ?? "正在读取预览…"}</pre>;
}
