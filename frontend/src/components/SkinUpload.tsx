"use client";

import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { PopButton } from "./zerun";
import { Spinner } from "./ui";

// ~900 KB ceiling on the raw image, matching the backend.
const MAX_BYTES = 900 * 1024;
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

// Read a File into a bare base64 string (the data: prefix stripped) plus its mime.
function readAsBase64(file: File): Promise<{ mime: string; dataB64: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      const dataB64 = comma >= 0 ? result.slice(comma + 1) : result;
      resolve({ mime: file.type, dataB64 });
    };
    reader.onerror = () => reject(reader.error || new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
}

// A small "Upload skin" control shown only to the agent's owner. Picks an image,
// previews it, and posts it; on success the skin shows everywhere via SkinnedAgent.
export function SkinUpload({
  agentId,
  owner,
  compact = false,
}: {
  agentId: number;
  owner: string;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const onPick = useCallback(
    async (file: File | undefined) => {
      setError(null);
      if (!file) return;
      if (!ACCEPT.split(",").includes(file.type)) {
        setError("Use a png, jpeg, webp, or gif image.");
        return;
      }
      if (file.size > MAX_BYTES) {
        setError("That image is a bit big. Keep it under 900 KB.");
        return;
      }
      setBusy(true);
      try {
        const { mime, dataB64 } = await readAsBase64(file);
        setPreview(`data:${mime};base64,${dataB64}`);
        await api.uploadSkin(agentId, { owner, mime, dataB64 });
        await queryClient.invalidateQueries({ queryKey: ["agents"] });
        await queryClient.invalidateQueries({ queryKey: ["operator"] });
      } catch (e) {
        setError(friendlyError(e, "Could not save that skin. Give it another go."));
        setPreview(null);
      } finally {
        setBusy(false);
      }
    },
    [agentId, owner, queryClient],
  );

  return (
    <div className={compact ? "inline-flex flex-col items-center gap-1" : "flex flex-col items-center gap-2"}>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          void onPick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {preview && (
        <img
          src={preview}
          alt="skin preview"
          className="h-14 w-14 rounded-chunk border-line border-ink object-cover shadow-pop-press"
        />
      )}
      <PopButton
        type="button"
        variant="ghost"
        size="md"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        icon={busy ? <Spinner /> : undefined}
        className={compact ? "px-3 py-2 text-[13px]" : ""}
      >
        Upload skin
      </PopButton>
      {error && <span className="font-body text-[12px] font-bold text-coral">{error}</span>}
    </div>
  );
}
