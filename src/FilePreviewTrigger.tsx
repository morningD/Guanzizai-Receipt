import { ConvertedMaterialPreview } from "./ConvertedMaterialPreview";
import { FolderSearch } from "lucide-react";
import { useState } from "react";
import { calculatePreviewPosition } from "./preview-position";
import { materialUrl } from "./store";
import type { ReceiptRecord } from "./types";

export function FilePreviewTrigger({ file, label = "定位", onOpen }: {
  file: ReceiptRecord;
  label?: string;
  onOpen?: () => void;
}) {
  const [position, setPosition] = useState<ReturnType<typeof calculatePreviewPosition> | null>(null);
  const isImage = ["jpg", "jpeg", "png"].includes(file.ext);
  const isText = file.ext === "txt" || file.ext === "ofd";
  const hasThumbnail = ["pdf", "doc", "docx"].includes(file.ext) || Boolean(onOpen && ["xlsx", "pptx"].includes(file.ext));
  const previewUrl = isImage || file.ext === "txt" ? materialUrl(file.path) : `/api/preview?path=${encodeURIComponent(file.path)}`;
  const reveal = async () => {
    const response = await fetch(`/api/reveal?path=${encodeURIComponent(file.path)}`, { method: "POST" });
    if (!response.ok) console.error("无法在文件管理器中显示材料");
  };
  const button = (
    <button type="button" className={onOpen ? "quiet-button" : "row-action"}
      onClick={() => {
        setPosition(null);
        if (onOpen) onOpen();
        else void reveal();
      }}>
      {!onOpen && <FolderSearch size={14} />} {label}
    </button>
  );
  if (!isImage && !hasThumbnail && !(onOpen && isText)) return button;

  return (
    <span className="preview-trigger" onPointerEnter={(event) => {
      if (event.pointerType === "touch") return;
      const rect = event.currentTarget.getBoundingClientRect();
      setPosition(calculatePreviewPosition(rect, { width: window.innerWidth, height: window.innerHeight }));
    }} onPointerLeave={() => setPosition(null)}>
      {button}
      {position && <span className="file-preview-popover" style={position} role="tooltip">
        <span className="preview-title">{file.name}</span>
        {isText
          ? <iframe src={previewUrl} title={`${file.name} 文本预览`} tabIndex={-1} />
          : isImage ? <img src={previewUrl} alt={`${file.name} 预览`} /> : <ConvertedMaterialPreview url={previewUrl} name={file.name} />}
      </span>}
    </span>
  );
}
